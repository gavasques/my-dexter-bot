// Current actual composition. Driver is synthetic; app native TLS, MCP, owner Unix and daemon TLS are real.
import https from 'node:https';
import http from 'node:http';
import {X509Certificate,createPrivateKey,generateKeyPairSync,randomBytes} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
const listeners=new Map();let devicePort,appPort;const createServer=https.createServer;https.createServer=function(...args){const server=createServer.apply(this,args);const counts={requests:0,polls:0,pollPeers:[]};listeners.set(server,counts);server.on('request',(req,res)=>{counts.requests++;let body='';const protocol=req.socket.getProtocol(),resumed=req.socket.isSessionReused();const raw=req.socket.getPeerCertificate().raw;const certificateDER=raw?Buffer.from(raw).toString('base64'):null;const fingerprint=raw?new X509Certificate(raw).fingerprint256.replaceAll(':','').toLowerCase():null;if(req.url==='/v1/device/poll')req.on('data',chunk=>body+=chunk);res.on('finish',()=>{if(req.url==='/v1/device/poll'&&res.statusCode===200){counts.polls++;counts.pollPeers.push({deviceId:JSON.parse(body).deviceId,fingerprint,certificateDER,protocol,resumed});}});});return server;};const count=port=>{const item=[...listeners].find(([server])=>server.address()?.port===port);assert.ok(item,'actual TLS listener instance');return item[1];};syncBuiltinESMExports();
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,chmodSync,readFileSync,existsSync,writeFileSync,copyFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {installNativeMaterialPipe,spawnWithMaterialPipe} from './current-native-memory-pipe.mjs';
import {mcpDirectoryClient} from './mcp-directory-client.mjs';
const [root,composition,realBrowser,nativeExecutable]=process.argv.slice(2);if(!root.startsWith('/private/tmp/')||!composition.startsWith('/private/tmp/'))throw Error('private lab only');
const imp=p=>import(pathToFileURL(join(composition,p)).href);
const {HostServices}=await imp('packages/cli/dist/host-services.js');
const {DeviceTurnSurface}=await imp('packages/cli/dist/device-turn-surface.js');
const {HostStore,hashRequest}=await imp('packages/hub/dist/index.js');
const {DevicePairingRegistry,FILE_APPEND,pairDevice,TlsIdentity}=await imp('packages/devices/dist/index.js');
const {NativeDeviceClient}=await imp('packages/devices/dist/native-client.js');
const {bindNativeDevice,readDaemonConfig}=await imp('packages/devices/dist/daemon-config.js');
const lateReceipts=new Map();const recordLate=DevicePairingRegistry.prototype.recordLateReceipt;DevicePairingRegistry.prototype.recordLateReceipt=function(receipt){recordLate.call(this,receipt);lateReceipts.set(receipt.actionId,this.lateReceipt(receipt.actionId));};
const until=async check=>{const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,10));}};
class Rpc{constructor(server){this.seq=0;this.pending=new Map();this.child=spawn(server.command,server.args,{stdio:'pipe',env:{PATH:'/usr/bin:/bin'}});this.child.stderr.resume();let b='';this.child.stdout.on('data',x=>{b+=x;while(b.includes('\n')){const n=b.indexOf('\n'),m=JSON.parse(b.slice(0,n));b=b.slice(n+1);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(Error('rpc')):p.resolve(m.result);}}});this.exited=new Promise(done=>this.child.once('close',()=>{for(const p of this.pending.values())p.reject(Error('closed'));this.pending.clear();done();}));}rpc(method,params){const id=++this.seq;const p=new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return p;}async init(){await this.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic',version:'1'}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}async close(){this.child.stdin.end();await this.exited;}}
mkdirSync(join(root,'host-id'),{mode:0o700});
function syntheticIdentity(subject,extensions){
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const keyPem=privateKey.export({type:'pkcs8',format:'pem'});
 const certPem=execFileSync('/usr/bin/openssl',['req','-new','-x509','-key','/dev/stdin','-out','/dev/stdout','-days','1','-subj','/CN='+subject,...extensions.flatMap(x=>['-addext',x])],{input:keyPem,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:root},stdio:['pipe','pipe','pipe']});
 const cert=new X509Certificate(certPem);assert.ok(cert.checkPrivateKey(privateKey));
 return new TlsIdentity(certPem,keyPem,cert.fingerprint256.replaceAll(':','').toLowerCase());
}
const identity=syntheticIdentity('owned-synthetic-host',['subjectAltName=IP:127.0.0.1','extendedKeyUsage=serverAuth']);
const peer=syntheticIdentity('owned-synthetic-agent',['extendedKeyUsage=clientAuth']);
writeFileSync(join(root,'host-id/cert.pem'),identity.certPem,{mode:0o600});
mkdirSync(join(root,'files'),{mode:0o700});mkdirSync(join(root,'control'),{mode:0o700});
const natives=[];let release;let services;let daemon;let browserMode=false;let browserBot;let heldEntered=false;let gateMode=false;let browserPeerBot;let pageServer,blockedServer;const pageHits=[],blockedHits=[];let pageOrigin,blockedOrigin;
const executedDrivers=new Map();let lastExecutedDriver;
const driver=(id,options)=>{
 const n={id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},receipts:[],failures:[],deviceToolCount:0,
 async status(){return {engine:id,installed:true,version:'synthetic',authentication:'authenticated',billing:'subscription'};},
 async open(threadId){
  this.stage='opening-rpc';this.threadID=threadId;this.rpc=new Rpc(options.localMcpServer);await this.rpc.init();this.stage='listing';
  this.directory=mcpDirectoryClient((method,params)=>this.rpc.rpc(method,params));
  this.tools=await this.directory.list();this.stage='opened';return {threadId,nativeCursor:'synthetic'};
 },
 async *turn(session,turnId,input){
  this.stage='turn-running';executedDrivers.set(turnId,this);lastExecutedDriver=this;
  try{
   const turn=services.store.getTurn(turnId);
   assert.equal(turn.threadId,session.threadId);
   const message=services.store.listMessages(session.threadId,0,1000).find(m=>m.id===turn.inputMessageId);
   assert.ok(message);assert.equal(message.role,'user');
   // The real driver receives host instructions as well as the user task. Retain that input,
   // and correlate the synthetic discriminator to this exact persisted turn input message.
   assert.ok(input.endsWith('\n\nUSER TASK:\n'+services.store.turnInput(turnId,{nativeContinuation:true})));
   const task=message.content;
   const lookup=async tool=>{const alias=await this.directory.find(tool);assert.ok(alias);this.deviceToolCount++;return alias;};
   const call=async(alias,callId,payload)=>this.directory.result(await this.directory.call(alias,callId,payload));
   const origin=[...executedDrivers.keys()].find(id=>id!==turnId && services.store.toolContinuationTurns(id).turnIds.includes(turnId));
   if(origin){
    assert.equal(services.store.getTurn(origin).threadId,turn.threadId);
    assert.equal(this.receipts.length,0); // Host receipt continuation performs no new effect.
   }else if(task==='unknown'){
    const alias=await lookup(FILE_APPEND);
    try{const r=await call(alias,'unknown-one',{name:'notes.txt',line:'unknown'});if(r.structuredContent)this.receipts.push(r.structuredContent);}catch{}
   }else if(task==='held'){
    this.held=true;this.worker=spawn(process.execPath,['-e','process.stdin.resume()'],{env:{PATH:'/usr/bin:/bin'},stdio:'pipe'});
    this.worker.stdout.resume();this.worker.stderr.resume();this.workerExited=new Promise(done=>this.worker.once('close',done));
    heldEntered=true;await new Promise(done=>{this.release=done;release=done;});
   }else if(task==='browser'||task==='browser-peer'){
    const expected=task==='browser'?'OWNED-SYNTHETIC':'ISOLATED-SYNTHETIC';
    for(const [tool,payload] of [['mac.browser.navigate',{url:pageOrigin+(task==='browser'?'/a':'/b')}],['mac.browser.read',{maxChars:100}]]){
     const alias=await lookup(tool);const r=await call(alias,tool,payload);
     assert.equal(r.structuredContent.status,'succeeded');this.receipts.push(r.structuredContent);
    }
    assert.ok(JSON.stringify(this.receipts).includes(expected));assert.ok(JSON.stringify(this.receipts).includes('untrusted_external'));
    const alias=await this.directory.find('mac.browser.navigate');
    const refused=await call(alias,'blocked-origin',{url:blockedOrigin+'/never'});
    assert.equal(refused.structuredContent.result.ok,false);assert.equal(blockedHits.length,0);
   }else if(task==='deny'){
    // First-party read tools remain exposed. None of the three executor tools can be
    // reached through either the direct list or the actual deferred directory lease.
    for(const canonical of [FILE_APPEND,'mac.browser.navigate','mac.browser.read']){
     assert.ok(!this.tools.some(t=>t.title?.startsWith(canonical+' ')));
     const found=this.directory.result(await this.rpc.rpc('tools/call',{name:'dx_catalog_search',arguments:{query:canonical,limit:20}}));
     assert.notEqual(found.isError,true);assert.ok(Array.isArray(found.structuredContent.tools));
     assert.equal(found.structuredContent.tools.filter(t=>t.title===canonical).length,0);
    }
    assert.equal(this.deviceToolCount,0);
   }else{
    assert.equal(task,'once');
    const alias=await lookup(FILE_APPEND);
    const append=async()=>{const r=await call(alias,'one',{name:'notes.txt',line:task});this.receipts.push(r.structuredContent);};
    // The actual bridge may hold the first RPC until the owner decision settles.
    // Publish the test-only scheduling gate before dispatch, never as approval authority.
    const humanReleased=new Promise(done=>{this.release=done;release=done;});const first=append();void first.catch(()=>{});
    await humanReleased;await first;assert.equal(this.receipts[0].status,'succeeded');
    await append();await append();
    assert.equal(new Set(this.receipts.map(r=>r.actionId)).size,1);
    assert.equal(new Set(this.receipts.map(r=>r.requestHash)).size,1);
    assert.ok(this.receipts.every(r=>r.status==='succeeded'));
   }
   this.stage='completed';yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
  }catch(e){this.stage='failed';this.failures.push(String(e));throw e;}
 },
 async respondToTool(){},async interrupt(){if(!this.held)this.release?.();},
 async close(){this.release?.();await this.rpc?.close();if(this.worker){this.worker.stdin.end();await this.workerExited;}}
 };natives.push(n);return n;
};
// macOS Unix path limit: short socket filename at lab-owned execution root.
const socket=join(root,'o.sock');
const makeServices=()=>new HostServices({dataDir:join(root,'store'),enableEngines:true,enableMcp:true,enableDeviceTools:true,makeDriver:driver,devices:{identity,pollWaitMs:50,receiptTimeoutMs:20000},appClients:{identity,listenHost:'127.0.0.1',port:0},ownerControl:{socketPath:socket}});
services=makeServices();
const url=await services.startDevices();devicePort=Number(new URL(url).port);const trust={hostUrl:url,hostFingerprint:identity.fingerprint,hostCertPem:identity.certPem};await services.startOwnerControl();
const actualCLI=join(root,'actual-native-cli');copyFileSync(nativeExecutable,actualCLI);chmodSync(actualCLI,0o700);
const helperPath=join(root,'native.json');const laboratoryID=randomBytes(16).toString('hex');const peerDER=new X509Certificate(peer.certPem).raw.toString('base64');
writeFileSync(helperPath,JSON.stringify({installationID:services.store.hostId,laboratoryID,hostURL:trust.hostUrl,hostCertificateDER:new X509Certificate(identity.certPem).raw.toString('base64'),hostFingerprint:trust.hostFingerprint}),{mode:0o600});
const jwk=createPrivateKey(peer.keyPem).export({format:'jwk'});const x963=Buffer.concat([Buffer.from([4]),...['x','y','d'].map(k=>Buffer.from(jwk[k],'base64url'))]);assert.equal(x963.length,97);
const material={fixtureMarker:'dexter-native-cli-forwarding-laboratory-v1',privateKeyX963:x963.toString('base64'),certificateDER:peerDER};x963.fill(0);const restoreNativePipe=installNativeMaterialPipe(actualCLI,material);
const nativeOptions={executable:actualCLI,configPath:helperPath,installationID:services.store.hostId,identityMode:'laboratory-native'};
const native=new NativeDeviceClient(nativeOptions);const loaded=await native.loadOnly(30000);assert.equal(loaded.policy,'cli_forwarding_laboratory_memory_only');assert.equal(loaded.fingerprint,peer.fingerprint);assert.equal(loaded.certificateDER,peerDER);bindNativeDevice(join(root,'peer'),loaded.fingerprint);
const offer=services.devicesAdmin.pairingBundle({kind:'pair'});const pairing=pairDevice({dataDir:join(root,'peer'),client:native,trust,offerId:offer.offerId,code:offer.code,name:'Owned real Swift agent',capabilities:[FILE_APPEND,'mac.browser.navigate','mac.browser.read'],pollIntervalMs:30});await until(()=>services.devicesAdmin.pendingClaims().length===1);const executorClaim=services.devicesAdmin.pendingClaims()[0];assert.equal(executorClaim.clientFingerprint,loaded.fingerprint);services.devicesAdmin.approveClaim(executorClaim.claimId);const deviceId=(await pairing).deviceId;await native.close();

const appURL=await services.startAppClients();appPort=Number(new URL(appURL).port);assert.notEqual(appPort,devicePort);const deniedApp=await new Promise((done,reject)=>{const req=https.request(new URL('/v1/health',appURL),{method:'GET',agent:false,cert:peer.certPem,key:peer.keyPem,ca:[identity.certPem],minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},res=>{res.resume();res.once('end',()=>done(res.statusCode));});req.once('error',reject);req.end();});assert.equal(deniedApp,403,'executor pair cannot authenticate app client');assert.equal(services.store.listActions().length,0);
async function owner(args){const child=spawn(process.execPath,[join(composition,'packages/cli/dist/index.js'),'app-client',...args,'--owner-control-socket',socket],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const code=await new Promise(done=>child.once('close',done));assert.equal(code,0,err);return JSON.parse(out);}
const bundle=await owner(['offer','--role','client-mac',...['approvals.decide','approvals.read','chat.read','chat.write','devices.manage','devices.read'].flatMap(s=>['--scope',s]),'--stdout']);assert.equal((await owner(['status'])).status,'ready');
async function startDaemon(expectRevoked=false){
 const config=join(root,'daemon.json');writeFileSync(config,JSON.stringify({mode:'laboratory',version:2,dataDir:join(root,'peer'),client:{kind:'native-helper',...nativeOptions},fixtureRoot:join(root,'files'),name:'Owned process Mac',capabilities:[FILE_APPEND],hostUrl:trust.hostUrl,hostCertPath:join(root,'host-id/cert.pem'),hostFingerprint:trust.hostFingerprint}),{mode:0o600});
 if(browserMode){const policyPath=join(root,'policy.json');writeFileSync(policyPath,JSON.stringify({version:1,bots:[browserBot,browserPeerBot].map(botId=>({botId,label:'Owned',operations:['mac.browser.navigate','mac.browser.read'],browserOrigins:[pageOrigin],cuaMaxSessionSeconds:0}))}),{mode:0o600});writeFileSync(config,JSON.stringify({mode:'local-capabilities',version:2,dataDir:join(root,'peer'),client:{kind:'native-helper',...nativeOptions},name:'Owned real Chromium',capabilities:['mac.browser.navigate','mac.browser.read'],hostUrl:trust.hostUrl,hostCertPath:join(root,'host-id/cert.pem'),hostFingerprint:trust.hostFingerprint,policyPath,browser:{executable:realBrowser,networkIsolation:'loopback_only'},cua:null}),{mode:0o600});assert.throws(()=>readDaemonConfig(config),e=>e.code==='forbidden');const permitted=JSON.parse(readFileSync(config,'utf8'));permitted.mode='laboratory-browser';writeFileSync(config,JSON.stringify(permitted),{mode:0o600});assert.equal(readDaemonConfig(config).mode,'laboratory-browser');}

 const entry=join(composition,'tests/fixtures/current-real-browser-agent.mjs'),args=['--config',config];
 const pollBefore=count(devicePort).polls;const child=spawnWithMaterialPipe(process.execPath,[entry,...args],{env:{PATH:'/usr/bin:/bin',DEXTER_FIXTURE_ROOT:root,DEXTER_FIXTURE_COMPOSITION:composition,DEXTER_FIXTURE_NATIVE:actualCLI,DEXTER_FIXTURE_BROWSER:realBrowser,DEXTER_FIXTURE_GATE:gateMode?'yes':'no'},stdio:'pipe'},material);let output='';child.stdout.on('data',x=>{output+=x;writeFileSync(join(root,'daemon-'+child.pid+'.stdout.log'),output,{mode:0o600});});let stderr='';child.stderr.on('data',x=>{stderr+=x;writeFileSync(join(root,'daemon-'+child.pid+'.stderr.log'),stderr,{mode:0o600});});const exited=new Promise((done,reject)=>child.once('close',c=>c===0||c===3?done():reject(Error('daemon exit '+c+' '+output))));void exited.catch(()=>{});daemon={pid:child.pid,async stop(){child.kill('SIGTERM');await exited;}};assert.notEqual(child.pid,process.pid);if(expectRevoked){await exited;assert.ok(output.includes('forbidden'));return;}await Promise.race([until(()=>output.includes('"ready"')&&count(devicePort).polls>pollBefore&&count(devicePort).pollPeers.at(-1).deviceId===deviceId&&count(devicePort).pollPeers.at(-1).fingerprint===loaded.fingerprint&&count(devicePort).pollPeers.at(-1).certificateDER===loaded.certificateDER&&services.devicesHttp.get(deviceId).presence==='online'),exited.then(()=>{throw Error('daemon exited before ready');})]);
}
// New discriminator only: AppClient list/rename precedes this command. Raw owner dispatch remains the public
// DeviceServices API for actions not owned by a turn surface. Effects use the actual separate daemon + Swift CLI.
// The production factory/native parser accepts 127.0.0.1 and ::1 only: this is a NEW PORT, not a network/interface switch.
async function agentLifecycle({botID,threadID,expectedName}){
 assert.equal(browserMode,false);assert.equal(gateMode,false);
 const view=()=>services.devicesHttp.list().find(d=>d.id===deviceId);
 assert.equal(view().name,expectedName);assert.equal(view().paired,true);
 const hostID=services.store.hostId,ownerID=services.store.ownerId,deviceCount=services.store.listDevices().length;
 const bindingBefore=readFileSync(join(root,'peer/binding.json'),'utf8');
 const file=join(root,'files/lifecycle.txt'),text=()=>existsSync(file)?readFileSync(file,'utf8'):'';
 const request=key=>services.store.requestAction({botId:botID,threadId:threadID,tool:FILE_APPEND,destination:deviceId,arguments:{name:'lifecycle.txt',line:key},idempotencyKey:'lifecycle-'+key});
 assert.throws(()=>request('without-grant'),e=>e.code==='forbidden');assert.equal(text(),'');
 // Exactly one owner-authorized grant. Restarts never grant anything.
 const grant=services.devicesAdmin.grant({botId:botID,tool:FILE_APPEND,destination:deviceId,policy:'allow'});
 const online=request('online');assert.equal((await services.devicesHttp.dispatch(online.id)).state,'succeeded');
 assert.equal(text(),'online\n');const offline=request('offline');assert.equal(offline.state,'ready');assert.equal(offline.result,null);
 const originalDaemonPID=daemon.pid;await daemon.stop();assert.throws(()=>process.kill(originalDaemonPID,0),e=>e.code==='ESRCH');
 const oldPort=devicePort,oldEndpoint=trust.hostUrl;
 // Restarting the genuine host drops authenticated presence; the stopped daemon cannot authenticate or run effects.
 // No synthetic clock/TTL change, no listener monkeypatch, no second writer and no authority bypass.
 async function restartHost(){
  const previousPort=devicePort;await services.shutdown({graceMs:5000});services=makeServices();const endpoint=await services.startDevices();
  devicePort=Number(new URL(endpoint).port);assert.notEqual(devicePort,previousPort,'fresh endpoint port');
  trust.hostUrl=endpoint;await services.startOwnerControl();const appEndpoint=await services.startAppClients();appPort=Number(new URL(appEndpoint).port);
  writeFileSync(helperPath,JSON.stringify({installationID:hostID,laboratoryID,hostURL:trust.hostUrl,hostCertificateDER:new X509Certificate(identity.certPem).raw.toString('base64'),hostFingerprint:trust.hostFingerprint}),{mode:0o600});
  assert.equal(services.store.hostId,hostID);assert.equal(services.store.ownerId,ownerID);assert.equal(services.store.listDevices().length,deviceCount);
  assert.equal(view().name,expectedName);assert.equal(readFileSync(join(root,'peer/binding.json'),'utf8'),bindingBefore);
 }
 await restartHost();assert.equal(new URL(trust.hostUrl).hostname,'127.0.0.1');assert.notEqual(trust.hostUrl,oldEndpoint);
 assert.equal(view().presence,'stale');const pollsBeforeOffline=count(devicePort).polls;
 let offlineCode=null;try{await services.devicesHttp.dispatch(offline.id);}catch(e){offlineCode=e.code;}
 assert.equal(offlineCode,'device_unavailable','REAL dispatch attempted while the daemon process is absent');
 assert.equal(services.store.getAction(offline.id).state,'ready');assert.equal(services.store.getAction(offline.id).result,null);
 assert.equal(text(),'online\n','offline dispatch has ZERO extra effects');assert.equal(count(devicePort).polls,pollsBeforeOffline);
 assert.deepEqual(services.store.getGrant(botID,FILE_APPEND,deviceId),grant,'restart does not add/bump grant');
 await startDaemon();assert.notEqual(daemon.pid,originalDaemonPID);const reconnectedPID=daemon.pid,peerObserved=count(devicePort).pollPeers.at(-1);
 assert.equal(peerObserved.deviceId,deviceId);assert.equal(peerObserved.fingerprint,loaded.fingerprint);assert.equal(peerObserved.certificateDER,loaded.certificateDER);
 assert.equal(peerObserved.protocol,'TLSv1.3');assert.equal(peerObserved.resumed,false);assert.equal(view().name,expectedName);const reconnectedPolls=count(devicePort).polls;assert.ok(reconnectedPolls>0);
 // Positive control dispatches the SAME previously unclaimed action once after genuine reauthentication.
 assert.equal((await services.devicesHttp.dispatch(offline.id)).state,'succeeded');assert.equal(text(),'online\noffline\n');
 assert.equal((await services.devicesHttp.dispatch(offline.id)).state,'succeeded');assert.equal(text(),'online\noffline\n','terminal replay has no second effect');
 const pending=request('after-revoke');assert.equal(pending.state,'ready');
 const deniedGrant=services.devicesAdmin.grant({botId:botID,tool:FILE_APPEND,destination:deviceId,policy:'deny'});
 services.devicesHttp.revoke(deviceId);assert.equal(view().paired,false);assert.notEqual(view().revokedAt,null);
 const revokedAt=view().revokedAt;await daemon.stop();assert.throws(()=>process.kill(reconnectedPID,0),e=>e.code==='ESRCH');
 await restartHost();assert.equal(view().name,expectedName);assert.equal(view().revokedAt,revokedAt);assert.equal(view().paired,false);assert.equal(view().presence,'revoked');
 await startDaemon(true);assert.notEqual(daemon.pid,reconnectedPID);const refusedPID=daemon.pid;assert.throws(()=>process.kill(refusedPID,0),e=>e.code==='ESRCH');
 assert.deepEqual(services.store.getGrant(botID,FILE_APPEND,deviceId),deniedGrant,'revoked grant stays denied after new processes');
 assert.throws(()=>services.devicesAdmin.grant({botId:botID,tool:FILE_APPEND,destination:deviceId,policy:'allow'}),e=>e.code==='forbidden');
 assert.throws(()=>request('no-restored-grant'),e=>e.code==='forbidden');
 assert.equal((await services.devicesHttp.dispatch(pending.id)).state,'blocked');assert.equal(services.store.getAction(pending.id).result,null);
 assert.equal(text(),'online\noffline\n');assert.equal(services.store.listActions().length,3);assert.equal(services.store.listDevices().length,deviceCount);
 const result={deviceID:deviceId,nameAfterRestart:view().name,oldEndpoint,newEndpoint:trust.hostUrl,endpointChange:'loopback-port-only',hostID,sameHostPin:trust.hostFingerprint===identity.fingerprint,
  peerFingerprint:peerObserved.fingerprint,peerCertificateDER:peerObserved.certificateDER,sameBindingBytes:readFileSync(join(root,'peer/binding.json'),'utf8')===bindingBefore,
  offlineCode,offlineStateBeforeReconnect:'ready',offlineResultBeforeReconnect:null,offlineExtraEffects:0,authenticatedPollsAfterReconnect:reconnectedPolls,
  totalEffects:text().trim().split('\n').length,positiveState:services.store.getAction(offline.id).state,revokedState:services.store.getAction(pending.id).state,revokedResult:services.store.getAction(pending.id).result,
  grantPolicy:services.store.getGrant(botID,FILE_APPEND,deviceId).policy,grantRevision:services.store.getGrant(botID,FILE_APPEND,deviceId).revision,revokedDurable:true,noNewDevice:true,
  daemonPIDs:[originalDaemonPID,reconnectedPID,refusedPID],driverTurns:natives.length};
 assert.equal(result.driverTurns,0,'owner discriminator causes no engine turn');
 writeFileSync(join(root,'agent-lifecycle.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
}
// AUTHOR2: same live HostServices, genuine 120s presence TTL; never reopen or change time/config.
async function agentContinuousOffline({botID,threadID}){
 assert.equal(browserMode,false);assert.equal(gateMode,false);
 const liveServices=services,liveStore=services.store,clock=liveStore.now,ttl=liveStore.deviceTtlMs,port=devicePort,endpoint=trust.hostUrl;
 assert.equal(ttl,120000,'production default TTL unchanged');
 const binding=readFileSync(join(root,'peer/binding.json'),'utf8'),deviceCount=liveStore.listDevices().length;
 const file=join(root,'files/continuous.txt'),text=()=>existsSync(file)?readFileSync(file,'utf8'):'';
 const request=key=>liveStore.requestAction({botId:botID,threadId:threadID,tool:FILE_APPEND,destination:deviceId,arguments:{name:'continuous.txt',line:key},idempotencyKey:'continuous-'+key});
 const grant=services.devicesAdmin.grant({botId:botID,tool:FILE_APPEND,destination:deviceId,policy:'allow'});
 const first=request('online');assert.equal((await services.devicesHttp.dispatch(first.id)).state,'succeeded');assert.equal(text(),'online\n');
 const action=request('offline');assert.equal(action.state,'ready');assert.equal(action.result,null);
 const firstPID=daemon.pid;await daemon.stop();assert.throws(()=>process.kill(firstPID,0),e=>e.code==='ESRCH');
 // This presence initially remains online from the real poll; wait wall time while SAME host keeps its listener/writer.
 assert.equal(services.devicesHttp.get(deviceId).presence,'online');const stoppedAt=Date.now(),polls=count(port).polls;
 const deadline=stoppedAt+ttl+5000;
 while(services.devicesHttp.get(deviceId).presence!=='stale'){
  assert.ok(Date.now()<deadline,'real presence expiry bounded');await new Promise(r=>setTimeout(r,50));
 }
 const expiredAt=Date.now();assert.ok(expiredAt-stoppedAt>=ttl-2000,'actual TTL elapsed, no reset/fake clock');
 assert.equal(services,liveServices);assert.equal(services.store,liveStore);assert.equal(liveStore.now,clock);assert.equal(liveStore.deviceTtlMs,ttl);
 assert.equal(devicePort,port);assert.equal(trust.hostUrl,endpoint);assert.equal(count(port).polls,polls);
 let offlineCode=null;try{await services.devicesHttp.dispatch(action.id);}catch(e){offlineCode=e.code;}
 assert.equal(offlineCode,'device_unavailable');assert.equal(liveStore.getAction(action.id).state,'ready');assert.equal(liveStore.getAction(action.id).result,null);
 assert.equal(text(),'online\n');assert.equal(count(port).polls,polls);assert.deepEqual(liveStore.getGrant(botID,FILE_APPEND,deviceId),grant);
 await startDaemon();const secondPID=daemon.pid;assert.notEqual(secondPID,firstPID);const peer=count(port).pollPeers.at(-1);
 assert.equal(peer.deviceId,deviceId);assert.equal(peer.fingerprint,loaded.fingerprint);assert.equal(peer.certificateDER,loaded.certificateDER);assert.equal(peer.protocol,'TLSv1.3');assert.equal(peer.resumed,false);
 assert.equal((await services.devicesHttp.dispatch(action.id)).state,'succeeded');assert.equal(text(),'online\noffline\n');
 assert.equal((await services.devicesHttp.dispatch(action.id)).state,'succeeded');assert.equal(text(),'online\noffline\n');
 const pending=request('after-revoke');assert.equal(pending.state,'ready');
 await daemon.stop();assert.throws(()=>process.kill(secondPID,0),e=>e.code==='ESRCH');const pollsBeforeRevoke=count(port).polls;
 // Revoke the physically absent daemon, keeping grant ALLOW unchanged to isolate destination revocation from deny.
 services.devicesHttp.revoke(deviceId);const revoked=services.devicesHttp.get(deviceId);assert.equal(revoked.paired,false);assert.equal(revoked.presence,'revoked');assert.notEqual(revoked.revokedAt,null);
 assert.deepEqual(liveStore.getGrant(botID,FILE_APPEND,deviceId),grant);
 assert.equal((await services.devicesHttp.dispatch(pending.id)).state,'blocked');assert.equal(liveStore.getAction(pending.id).result,null);assert.equal(liveStore.getAction(pending.id).reason,'permission_changed');
 assert.equal(text(),'online\noffline\n');assert.equal(count(port).polls,pollsBeforeRevoke);
 await startDaemon(true);const thirdPID=daemon.pid;assert.notEqual(thirdPID,secondPID);assert.throws(()=>process.kill(thirdPID,0),e=>e.code==='ESRCH');
 assert.equal(services,liveServices);assert.equal(services.store,liveStore);assert.equal(liveStore.now,clock);assert.equal(devicePort,port);assert.equal(trust.hostUrl,endpoint);
 assert.equal(services.devicesHttp.get(deviceId).revokedAt,revoked.revokedAt);assert.equal(services.devicesHttp.get(deviceId).presence,'revoked');assert.deepEqual(liveStore.getGrant(botID,FILE_APPEND,deviceId),grant,'historical allow unchanged, no auto/default/restored grant');
 assert.throws(()=>services.devicesAdmin.grant({botId:botID,tool:FILE_APPEND,destination:deviceId,policy:'allow'}),e=>e.code==='forbidden');const actionsBeforeFresh=liveStore.listActions().length,eventsBeforeFresh=liveStore.listEvents(0,1000).length;assert.throws(()=>request('revoked-new'),e=>e.code==='forbidden');assert.equal(liveStore.listActions().length,actionsBeforeFresh);assert.equal(liveStore.listEvents(0,1000).length,eventsBeforeFresh);
 assert.equal((await services.devicesHttp.dispatch(pending.id)).state,'blocked');assert.equal(text(),'online\noffline\n');assert.equal(count(port).polls,pollsBeforeRevoke);
 assert.equal(readFileSync(join(root,'peer/binding.json'),'utf8'),binding);assert.equal(liveStore.listDevices().length,deviceCount);assert.equal(liveStore.listActions().length,3);assert.equal(natives.length,0);
 const result={deviceID:deviceId,sameHostServices:true,sameStore:true,hostRestarts:0,endpointUnchanged:true,clockUnchanged:true,ttlMs:ttl,stoppedAt,expiredAt,elapsedMs:expiredAt-stoppedAt,
  offlineCode,offlineStateBeforeReconnect:'ready',offlineResultBeforeReconnect:null,offlineExtraEffects:0,positiveState:liveStore.getAction(action.id).state,terminalReplayExtraEffects:0,
  revokeWhileDaemonAbsent:true,revokeGrantPolicy:grant.policy,revokeGrantRevision:grant.revision,revokedState:liveStore.getAction(pending.id).state,revokedReason:liveStore.getAction(pending.id).reason,revokedResult:liveStore.getAction(pending.id).result,
  revokedAt:revoked.revokedAt,revokedRestartNoSuccessfulPolls:count(port).polls===pollsBeforeRevoke,totalEffects:2,grantUnchanged:true,newGrantRefused:true,newActionRefusedBeforeInsert:true,newActionAdmissionCode:'forbidden',newActionAddedActions:0,newActionAddedEvents:0,
  sameBindingBytes:true,noNewDevice:true,daemonPIDs:[firstPID,secondPID,thirdPID],driverTurns:natives.length};
 writeFileSync(join(root,'agent-continuous.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
}
async function startPages(){
 blockedServer=http.createServer((req,res)=>{blockedHits.push(req.url);res.end('OWNED-BLOCKED');});await new Promise(done=>blockedServer.listen(0,'127.0.0.1',done));blockedOrigin='http://127.0.0.1:'+blockedServer.address().port;
 pageServer=http.createServer((req,res)=>{pageHits.push(req.url);writeFileSync(join(root,'page-gets.json'),JSON.stringify(pageHits),{mode:0o600});res.setHeader('content-type','text/html; charset=utf-8');if(req.url==='/a'){res.setHeader('set-cookie','owned=bot-a; Path=/; SameSite=Lax');res.end('<title>Owned real page</title><body>OWNED-SYNTHETIC<img hidden src="'+blockedOrigin+'/forbidden.png"></body>');}else if(req.url==='/b'){res.end('<title>Owned isolated page</title><body><script>document.body.innerText=document.cookie.includes("owned=bot-a")?"LEAKED-SYNTHETIC":"ISOLATED-SYNTHETIC"</script></body>');}else{res.statusCode=404;res.end('missing');}});await new Promise(done=>pageServer.listen(0,'127.0.0.1',done));pageOrigin='http://127.0.0.1:'+pageServer.address().port;
}
const browserEvents=()=>readFileSync(join(root,'chromium-events.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
function verifyBrowserIsolation(){const events=browserEvents(),spawns=events.filter(e=>e.event==='spawn');assert.equal(spawns.length,2);const profiles=spawns.map(e=>e.argv.find(a=>a.startsWith('--user-data-dir=')));assert.equal(new Set(profiles).size,2);for(const e of spawns){assert.ok(e.argv.includes('--remote-debugging-pipe'));assert.ok(!e.argv.some(a=>a.startsWith('--remote-debugging-port')));assert.ok(e.argv.includes('--disable-background-networking'));assert.ok(profiles.every(p=>p.startsWith('--user-data-dir='+root+'/peer/')));}assert.equal(blockedHits.length,0);assert.ok(pageHits.includes('/a')&&pageHits.includes('/b'));assert.equal(events.filter(e=>e.event==='cdp-version').length,2);const pgids=new Set(spawns.map(e=>e.pid));const owned=execFileSync('/bin/ps',['-axo','pid=,pgid='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)).filter(([,pgid])=>pgids.has(pgid)).map(([pid])=>pid);assert.ok(owned.length>=2);let listening='';try{listening=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',owned.join(','),'-iTCP','-sTCP:LISTEN'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});}catch(e){assert.equal(e.status,1);assert.equal(String(e.stdout),'');}assert.equal(listening,'');writeFileSync(join(root,'browser-owned-pids.json'),JSON.stringify({pids:owned,pgids:[...pgids],debugTcpListeners:0}),{mode:0o600});}
function verifyBrowserDrain(){assert.equal(blockedHits.length,0);assert.ok(pageHits.includes('/a')&&pageHits.includes('/b'));const events=browserEvents();for(const e of events.filter(e=>e.event==='spawn')){assert.ok(events.some(x=>x.event==='close'&&x.pid===e.pid));assert.throws(()=>process.kill(-e.pid,0),error=>error.code==='ESRCH');}}
async function closePages(){for(const server of [pageServer,blockedServer])if(server)await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));}
try{await startDaemon();}catch(e){await daemon?.stop();await services.shutdown({graceMs:5000});throw e;}const send=x=>process.stdout.write(JSON.stringify(x)+'\n');send({bundle,nativePolicy:loaded.policy,agentFingerprint:loaded.fingerprint,agentCertificateDER:loaded.certificateDER});
const input=createInterface({input:process.stdin,crlfDelay:Infinity});let cleaned=false;
async function cleanup(){if(cleaned)return;cleaned=true;release?.();if(gateMode)writeFileSync(join(root,'effect-release'),'release',{mode:0o600});await daemon?.stop();if(browserMode){verifyBrowserDrain();}await services.shutdown({graceMs:5000});await closePages();input.close();}
process.on('SIGTERM',()=>void cleanup().finally(()=>process.exit(0)));
for await(const line of input){try{const c=JSON.parse(line);let result={};
if(c.op==='approve'){const claims=await owner(['claims']);const claim=claims.items.find(x=>x.claimId===c.claimID);assert.ok(claim);assert.equal(claim.clientFingerprint,c.fingerprint);result=await owner(['approve',c.claimID,'--fingerprint',claim.clientFingerprint]);result.approvedFingerprint=claim.clientFingerprint;assert.equal(result.grantsCreated,0);}
else if(c.op==='route'){services.deviceRoutesAdmin.bindRoute({botId:c.botID,deviceId,tool:FILE_APPEND});result={deviceID:deviceId};}
else if(c.op==='agent_lifecycle'){result=await agentLifecycle(c);}
else if(c.op==='agent_continuous'){result=await agentContinuousOffline(c);}
else if(c.op==='ask'){services.devicesAdmin.grant({botId:c.botID,tool:FILE_APPEND,destination:deviceId,policy:'ask'});}
else if(c.op==='pending'){await until(()=>services.store.listActions().some(a=>a.state==='awaiting_approval'));const a=services.store.listActions()[0];assert.equal(a.requestHash,hashRequest(a.request));assert.equal(existsSync(join(root,'files/notes.txt')),false);result={actionID:a.id,state:a.state};}
else if(c.op==='release'){release();}
else if(c.op==='wait'){await services.runtime.waitForTurn(c.turnID);result={state:services.store.getTurn(c.turnID).state,driverFailures:natives.flatMap(n=>n.failures),toolCount:executedDrivers.get(c.turnID).deviceToolCount,receipts:executedDrivers.get(c.turnID).receipts};}
else if(c.op==='reconnect'){await daemon.stop();const now=services.store.now.bind(services.store);services.store.now=()=>now()+services.store.deviceTtlMs+1;try{assert.equal(services.devicesHttp.get(deviceId).presence,'stale');}finally{services.store.now=now;}const before=count(devicePort).polls;await startDaemon();assert.equal(services.devicesHttp.get(deviceId).paired,true);const observed=count(devicePort).pollPeers.at(-1);assert.equal(observed.protocol,'TLSv1.3');assert.equal(observed.resumed,false);assert.equal(observed.deviceId,deviceId);assert.equal(observed.fingerprint,loaded.fingerprint);assert.equal(observed.certificateDER,loaded.certificateDER);result={sameID:observed.deviceId,peerFingerprint:observed.fingerprint,peerCertificateDER:observed.certificateDER,staleAfterDrain:true,freshAuthenticatedPolls:count(devicePort).polls-before};}
else if(c.op==='browser'){await daemon.stop();browserMode=true;browserBot=c.botID;browserPeerBot=c.peerBotID;await startPages();for(const tool of ['mac.browser.navigate','mac.browser.read']){for(const botId of [browserBot,browserPeerBot]){services.deviceRoutesAdmin.bindRoute({botId,deviceId,tool});services.devicesAdmin.grant({botId,tool,destination:deviceId,policy:'allow'});}}await startDaemon();}
else if(c.op==='revoke'){services.devicesHttp.revoke(deviceId);await daemon.stop();await startDaemon(true);assert.equal(services.devicesHttp.get(deviceId).paired,false);for(const b of services.store.listBots())assert.throws(()=>services.devicesAdmin.grant({botId:b.id,tool:FILE_APPEND,destination:deviceId,policy:'allow'}));}
else if(c.op==='browser_verify'){verifyBrowserIsolation();result={realBrowser:true,ownedGETs:pageHits.length,blockedGETs:blockedHits.length,isolatedProfiles:true};}
else if(c.op==='inspect'){let held=false;try{new HostStore({dataDir:join(root,'store')}).close();}catch(e){held=e.code==='host_locked';}result={appHTTP:count(appPort).requests,deviceHTTP:count(devicePort).requests,appPort,devicePort,authenticatedPolls:count(devicePort).polls,writerHeld:held,actions:services.store.listActions().length,natives:natives.length,receipts:lastExecutedDriver?.receipts.map(r=>r.status),text:existsSync(join(root,'files/notes.txt'))?readFileSync(join(root,'files/notes.txt'),'utf8'):'',deviceID:deviceId};}
else if(c.op==='unknown_mode'){await daemon.stop();gateMode=true;await startDaemon();services.deviceRoutesAdmin.bindRoute({botId:c.botID,deviceId,tool:FILE_APPEND});services.devicesAdmin.grant({botId:c.botID,tool:FILE_APPEND,destination:deviceId,policy:'allow'});}
else if(c.op==='unknown_cancel'){await until(()=>existsSync(join(root,'effect-entered')));assert.equal(services.store.listActions()[0].state,'running');assert.equal(readFileSync(join(root,'files/notes.txt'),'utf8'),'');services.runtime.cancelTurn(c.turnID);await services.runtime.waitForTurn(c.turnID);await until(()=>services.store.listActions()[0].state==='unknown');writeFileSync(join(root,'effect-release'),'release',{mode:0o600});await until(()=>existsSync(join(root,'files/notes.txt'))&&readFileSync(join(root,'files/notes.txt'),'utf8')==='unknown\n');assert.equal(readFileSync(join(root,'effect-entered'),'utf8'),'entered\n');const action=services.store.listActions()[0];await until(()=>lateReceipts.get(action.id)?.status==='completed');await assert.rejects(services.devicesHttp.dispatch(action.id),e=>e.code==='forbidden'&&/owned by a turn tool surface/.test(e.message));assert.equal(services.store.listActions().length,1);assert.equal(services.store.getAction(action.id).state,'unknown');result={lateReceiptStatus:lateReceipts.get(action.id).status,unknown:true,physicalAppendAfterCancellation:true,noSecondDispatch:true,redispatchRefusal:'turn_owned'};}
else if(c.op==='unknown_verify'){const action=services.store.listActions()[0];assert.equal(action.state,'unknown');assert.equal(lateReceipts.get(action.id).status,'completed');assert.equal(readFileSync(join(root,'effect-entered'),'utf8'),'entered\n');assert.equal(readFileSync(join(root,'files/notes.txt'),'utf8'),'unknown\n');result={state:action.state,effects:1,lateReceiptStatus:'completed'};}
else if(c.op==='held_shutdown'){await until(()=>heldEntered);const retained=services.deviceRoutesAdmin;await assert.rejects(services.shutdown({graceMs:10}));assert.throws(()=>retained.bindRoute({botId:services.store.listBots()[0].id,deviceId,tool:FILE_APPEND}));await assert.rejects(services.startOwnerControl());assert.throws(()=>new HostStore({dataDir:join(root,'store')}),e=>e.code==='host_locked');const heldDrivers=natives.filter(n=>n.held);assert.equal(heldDrivers.length,1);assert.equal(heldDrivers[0].worker.exitCode,null);result={writerHeld:true,driverProcessAlive:true,admissionClosed:true};}
else if(c.op==='quarantine'){await daemon.stop();const retained=services.deviceRoutesAdmin,old=DeviceTurnSurface.prototype.close;let closes=0;DeviceTurnSurface.prototype.close=async function(){closes++;await old.call(this);throw Error('owned after-drain rejection');};try{await assert.rejects(services.shutdown({graceMs:5000}));await assert.rejects(services.shutdown({graceMs:5000}));assert.equal(closes,1);assert.throws(()=>new HostStore({dataDir:join(root,'store')}),e=>e.code==='host_locked');assert.throws(()=>retained.listRoutes());for(const n of executedDrivers.values()){assert.ok(n.rpc);assert.notEqual(n.rpc.child.exitCode,null);}await assert.rejects(services.startOwnerControl());}finally{DeviceTurnSurface.prototype.close=old;}if(browserMode){verifyBrowserDrain();}services.store.close();const reopened=new HostStore({dataDir:join(root,'store')});assert.notEqual(reopened.getDevice(deviceId).revokedAt,null);reopened.close();await closePages();cleaned=true;input.close();send({quarantined:true,writerHeld:true,resourcesDrained:true,fixtureWriterReleased:true});break;}
else if(c.op==='stop'){await cleanup();await assert.rejects(services.startOwnerControl());const reopen=new HostStore({dataDir:join(root,'store')});reopen.close();send({writerReleased:true});break;}else throw Error('closed command');send(result);
}catch(e){process.stderr.write('driver progress '+JSON.stringify(natives.map(n=>({id:n.id,threadID:n.threadID,stage:n.stage,failures:n.failures})))+'\n');process.stderr.write('command '+JSON.parse(line).op+': '+String(e.stack)+'\n');send({fixtureError:true});}}
await cleanup();
