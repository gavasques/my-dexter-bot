// TEST ONLY: a supervisor retains synthetic material in memory and controls two REAL Host Node processes.
// Direct owner DeviceServices actions, no engine/MCP/browser. HostStore lease/authority fencing is unchanged.
import assert from 'node:assert/strict';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {createPrivateKey,X509Certificate,randomBytes} from 'node:crypto';
import {mkdirSync,copyFileSync,chmodSync,writeFileSync,appendFileSync,readFileSync,existsSync,realpathSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {installNativeMaterialPipe,spawnWithMaterialPipe} from './current-native-memory-pipe.mjs';
const [root,composition,nativeExecutable,role]=process.argv.slice(2);
assert.ok(root.startsWith('/private/tmp/')&&realpathSync(root)===root&&(lstatSync(root).mode&0o077)===0);
assert.ok(composition.startsWith('/private/tmp/'));
const imp=p=>import(pathToFileURL(join(composition,p)).href);
const until=async check=>{const end=Date.now()+10000;while(!await check()){if(Date.now()>=end)throw Error('bounded fixture deadline');await new Promise(r=>setTimeout(r,20));}};
const {HostStore}=await imp('packages/hub/dist/index.js');
const {TlsIdentity,createLabTlsIdentity,FILE_APPEND,pairDevice}=await imp('packages/devices/dist/index.js');
const env={PATH:'/usr/bin:/bin',HOME:join(root,'home'),TMPDIR:join(root,'tmp')+'/'};
const log=(name,value)=>appendFileSync(join(root,name),JSON.stringify(value)+'\n',{mode:0o600});
function bounded(value){assert.ok(Buffer.byteLength(JSON.stringify(value))<=65536);return value;}
function identityPacket(raw){
 assert.deepEqual(Object.keys(raw).sort(),['certPem','fingerprint','keyPem']);
 for(const name of ['certPem','fingerprint','keyPem'])assert.equal(typeof raw[name],'string');
 assert.ok(Buffer.byteLength(JSON.stringify(raw))<=16384);
 const cert=new X509Certificate(raw.certPem);assert.ok(cert.checkPrivateKey(createPrivateKey(raw.keyPem)));
 assert.equal(cert.fingerprint256.replaceAll(':','').toLowerCase(),raw.fingerprint);
 return new TlsIdentity(raw.certPem,raw.keyPem,raw.fingerprint);
}
if(role==='--host'){
 // Observation only: the real listeners still configure and enforce their actual mTLS/HTTP policies.
 const servers=[];const original=https.createServer;
 https.createServer=function(...args){const server=original.apply(this,args),events=[];servers.push({server,events});server.on('request',(req,res)=>{
  const raw=req.socket.getPeerCertificate().raw;
  const event={route:req.url,protocol:req.socket.getProtocol(),resumed:req.socket.isSessionReused(),fingerprint:raw?new X509Certificate(raw).fingerprint256.replaceAll(':','').toLowerCase():null,certificateDER:raw?raw.toString('base64'):null};
  res.once('finish',()=>events.push({...event,status:res.statusCode}));
 });return server;};syncBuiltinESMExports();
 const {HostServices}=await imp('packages/cli/dist/host-services.js');
 let services,deviceURL,appURL,closing=false;
 const owner=async args=>{
  const child=spawn(process.execPath,[join(composition,'packages/cli/dist/index.js'),'app-client',...args,'--owner-control-socket',join(root,'o.sock')],{env,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',x=>{out+=x;assert.ok(out.length<=65536);});child.stderr.on('data',x=>err+=x);
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const code=await new Promise(done=>child.once('close',done));clearTimeout(timer);assert.equal(code,0);assert.equal(err,'');return JSON.parse(out);
 };
 const snapshot=c=>({authority:services.store.authorityStatus(),main:services.peersHttp.get(c.mainID),revoked:services.peersHttp.get(c.revokedID),app:services.peersHttp.get(c.appID),mainGrant:services.store.getGrant(c.botID,FILE_APPEND,c.mainID),revokedGrant:services.store.getGrant(c.botID,FILE_APPEND,c.revokedID),actions:services.store.listActions(),messages:services.store.listMessages(c.threadID),effect:existsSync(join(root,'files/restart.txt'))?readFileSync(join(root,'files/restart.txt'),'utf8'):''});
 const stop=async()=>{if(closing)return;closing=true;await services?.shutdown({graceMs:5000});};
 process.on('SIGTERM',()=>void stop().then(()=>{process.disconnect?.();}).catch(()=>process.exit(2)));
 let serial=Promise.resolve();
 process.on('message',message=>{serial=serial.then(async()=>{
  try{
   bounded(message);const c=message;assert.equal(typeof c.id,'number');assert.ok(Number.isSafeInteger(c.id)&&c.id>=0);
   let result;
   if(c.op==='boot'){
    assert.equal(services,undefined);assert.deepEqual(Object.keys(c).sort(),['id','identity','op','ports']);
    assert.deepEqual(Object.keys(c.ports).sort(),['app','device']);for(const port of Object.values(c.ports))assert.ok(Number.isSafeInteger(port)&&port>=0&&port<=65535);
    const identity=identityPacket(c.identity);c.identity=null;
    services=new HostServices({dataDir:join(root,'store'),devices:{identity,port:c.ports.device,pollWaitMs:50,receiptTimeoutMs:20000},appClients:{identity,listenHost:'127.0.0.1',port:c.ports.app},ownerControl:{socketPath:join(root,'o.sock')}});
    deviceURL=await services.startDevices();appURL=await services.startAppClients();await services.startOwnerControl();
    result={pid:process.pid,hostID:services.store.hostId,ownerID:services.store.ownerId,deviceURL,appURL,authority:services.store.authorityStatus()};
   }else if(c.op==='pair_offer')result=services.devicesAdmin.pairingBundle({kind:'pair'});
   else if(c.op==='claims')result=services.devicesAdmin.pendingClaims();
   else if(c.op==='approve_agent')result=services.devicesAdmin.approveClaim(c.claimID);
   else if(c.op==='app_bundle')result=await owner(['offer','--role','client-mac',...['approvals.read','chat.read','chat.write','devices.manage','devices.read'].flatMap(s=>['--scope',s]),'--stdout']);
   else if(c.op==='approve'){
    const claims=await owner(['claims']);const claim=claims.items.find(x=>x.claimId===c.claimID);assert.ok(claim);assert.equal(claim.clientFingerprint,c.fingerprint);
    result=await owner(['approve',c.claimID,'--fingerprint',c.fingerprint]);assert.equal(result.grantsCreated,0);result.approvedFingerprint=c.fingerprint;
   }else if(c.op==='polls'){
    const server=servers.find(item=>item.server.address()?.port===Number(new URL(deviceURL).port));
    result={polls:server.events.filter(e=>e.route==='/v1/device/poll'),mainPresence:services.devicesHttp.get(c.mainID).presence};
   }else if(c.op==='prepare'){
    assert.equal(services.store.getGrant(c.botID,FILE_APPEND,c.mainID),null);
    assert.throws(()=>services.store.requestAction({botId:c.botID,threadId:c.threadID,tool:FILE_APPEND,destination:c.mainID,arguments:{name:'restart.txt',line:'ungranted'},idempotencyKey:'ungranted'}),e=>e.code==='forbidden');
    const request=(key,line)=>services.store.requestAction({botId:c.botID,threadId:c.threadID,tool:FILE_APPEND,destination:c.mainID,arguments:{name:'restart.txt',line},idempotencyKey:key});
    services.devicesAdmin.grant({botId:c.botID,tool:FILE_APPEND,destination:c.mainID,policy:'allow'});
    const action=request('process-once','before-process-restart');assert.equal((await services.devicesHttp.dispatch(action.id)).state,'succeeded');
    const pending=request('process-denied','must-not-run');assert.equal(pending.state,'ready');
    services.devicesAdmin.grant({botId:c.botID,tool:FILE_APPEND,destination:c.mainID,policy:'deny'});
    services.devicesAdmin.grant({botId:c.botID,tool:FILE_APPEND,destination:c.revokedID,policy:'allow'});
    services.devicesAdmin.grant({botId:c.botID,tool:FILE_APPEND,destination:c.revokedID,policy:'deny'});services.devicesHttp.revoke(c.revokedID);
    assert.equal(services.store.getAction(pending.id).state,'blocked');assert.equal(services.store.getAction(pending.id).reason,'permission_changed');assert.equal(services.store.getAction(pending.id).result,null);
    result={...snapshot(c),actionID:action.id,pendingID:pending.id};assert.equal(result.effect,'before-process-restart\n');assert.equal(result.messages.length,1);
   }else if(c.op==='after_restart'){
    const before=c.before,after=snapshot(c);assert.deepEqual(after.authority,before.authority);
    assert.deepEqual(after.mainGrant,before.mainGrant);assert.deepEqual(after.revokedGrant,before.revokedGrant);
    for(const name of ['main','revoked','app'])for(const key of ['id','name','paired','revokedAt'])assert.deepEqual(after[name][key],before[name][key]);
    assert.deepEqual(after.messages,before.messages);assert.equal(after.actions.length,2);
    assert.equal((await services.devicesHttp.dispatch(before.actionID)).state,'succeeded');
    assert.equal((await services.devicesHttp.dispatch(before.pendingID)).state,'blocked');assert.equal(services.store.getAction(before.pendingID).result,null);
    assert.throws(()=>services.store.requestAction({botId:c.botID,threadId:c.threadID,tool:FILE_APPEND,destination:c.mainID,arguments:{name:'restart.txt',line:'no-auto-grant'},idempotencyKey:'no-auto-grant'}),e=>e.code==='forbidden');
    assert.throws(()=>services.devicesAdmin.grant({botId:c.botID,tool:FILE_APPEND,destination:c.revokedID,policy:'allow'}),e=>e.code==='forbidden');
    result=snapshot(c);assert.equal(result.effect,'before-process-restart\n');assert.equal(result.mainGrant.policy,'deny');assert.equal(result.mainGrant.revision,2);
    assert.equal(result.revoked.paired,false);assert.equal(result.revoked.revokedAt,before.revoked.revokedAt);
   }else if(c.op==='stop'){await stop();result={drained:true};}
   else throw Error('closed fixture command');
   process.send(bounded({id:c.id,result}),()=>{if(c.op==='stop')process.disconnect();});
  }catch{process.send?.({id:message.id,error:'host_fixture_refused'});if(!services){process.disconnect?.();process.exitCode=2;}}
 });});
}else{
 assert.equal(role,undefined);
 for(const name of ['home','tmp','files','peer-main','peer-revoked'])mkdirSync(join(root,name),{mode:0o700});
 const {NativeDeviceClient}=await imp('packages/devices/dist/native-client.js');const {bindNativeDevice}=await imp('packages/devices/dist/daemon-config.js');
 const hostIdentity=createLabTlsIdentity({profile:'host',name:'Host process memory fixture'}).identity;
 writeFileSync(join(root,'host-cert.pem'),hostIdentity.certPem,{mode:0o600});
 class HostProcess{
  constructor(ports){
   this.child=spawn(process.execPath,[process.argv[1],root,composition,nativeExecutable,'--host'],{env,stdio:['ignore','pipe','pipe','ipc']});this.pid=this.child.pid;this.next=0;this.pending=new Map();
   this.child.stdout.on('data',bytes=>{assert.equal(bytes.length,0);});this.child.stderr.on('data',bytes=>appendFileSync(join(root,'host-'+this.pid+'.stderr.log'),bytes,{mode:0o600}));
   this.child.on('message',m=>{bounded(m);const entry=this.pending.get(m.id);if(!entry)return;this.pending.delete(m.id);clearTimeout(entry.timer);m.error?entry.reject(Error(m.error)):entry.resolve(m.result);});
   this.exited=new Promise(done=>this.child.once('close',(code,signal)=>{for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Error('actual host closed'));}this.pending.clear();log('host-process-events.jsonl',{event:'close',pid:this.pid,code,signal});done({code,signal});}));
   log('host-process-events.jsonl',{event:'spawn',pid:this.pid});
   this.ready=this.command('boot',{identity:{certPem:hostIdentity.certPem,keyPem:hostIdentity.keyPem,fingerprint:hostIdentity.fingerprint},ports});
  }
  command(op,values={}){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('bounded host RPC'));},10000);this.pending.set(id,{resolve,reject,timer});this.child.send(bounded({id,op,...values}));});}
  async stop(){await this.command('stop');const result=await this.exited;assert.equal(result.code,0);assert.throws(()=>process.kill(this.pid,0),e=>e.code==='ESRCH');}
 }
 const leases=()=>{const db=new DatabaseSync(join(root,'store/dexter.sqlite'),{readOnly:true});try{return db.prepare('SELECT pid FROM host_lease').all().map(row=>row.pid);}finally{db.close();}};
 let host,daemon;let cleaned=false;const daemonPIDs=[],hosts=[],restores=[];let ids,before,initial;
 const materialFor=(identity)=>{const cert=new X509Certificate(identity.certPem),jwk=createPrivateKey(identity.keyPem).export({format:'jwk'});const bytes=Buffer.concat([Buffer.from([4]),...['x','y','d'].map(name=>Buffer.from(jwk[name],'base64url'))]);assert.equal(bytes.length,97);const material={fixtureMarker:'dexter-native-cli-forwarding-laboratory-v1',privateKeyX963:bytes.toString('base64'),certificateDER:cert.raw.toString('base64')};bytes.fill(0);return material;};
 const peers=[];
 async function pairPeer(label){
  const identity=createLabTlsIdentity({profile:'client',name:'Host process '+label}).identity,material=materialFor(identity),executable=join(root,'actual-cli-'+label),configPath=join(root,'native-'+label+'.json');copyFileSync(nativeExecutable,executable);chmodSync(executable,0o700);
  writeFileSync(configPath,JSON.stringify({installationID:initial.hostID,laboratoryID:randomBytes(16).toString('hex'),hostURL:initial.deviceURL,hostCertificateDER:new X509Certificate(hostIdentity.certPem).raw.toString('base64'),hostFingerprint:hostIdentity.fingerprint}),{mode:0o600});
  restores.push(installNativeMaterialPipe(executable,material,(child)=>{log('native-events.jsonl',{event:'spawn',pid:child.pid});child.once('close',(code,signal)=>log('native-events.jsonl',{event:'close',pid:child.pid,code,signal}));}));
  const options={executable,configPath,installationID:initial.hostID,identityMode:'laboratory-native'},client=new NativeDeviceClient(options),loaded=await client.loadOnly(30000);assert.equal(loaded.fingerprint,identity.fingerprint);assert.equal(loaded.policy,'cli_forwarding_laboratory_memory_only');
  const dataDir=join(root,'peer-'+label);bindNativeDevice(dataDir,loaded.fingerprint);const offer=await host.command('pair_offer');
  const pairing=pairDevice({dataDir,client,trust:{hostUrl:initial.deviceURL,hostFingerprint:hostIdentity.fingerprint,hostCertPem:hostIdentity.certPem},offerId:offer.offerId,code:offer.code,name:'Process '+label,capabilities:[FILE_APPEND],pollIntervalMs:30});
  let claim;await until(async()=>{claim=(await host.command('claims')).find(c=>c.clientFingerprint===loaded.fingerprint);return !!claim;});await host.command('approve_agent',{claimID:claim.claimId});const paired=await pairing;await client.close();
  const peer={material,options,loaded,dataDir,deviceId:paired.deviceId};peers.push(peer);return peer;
 }
 async function startDaemon(peer,revoked=false){
  const config=join(root,'daemon-'+peer.deviceId+'.json');writeFileSync(config,JSON.stringify({mode:'laboratory',version:2,dataDir:peer.dataDir,client:{kind:'native-helper',...peer.options},fixtureRoot:join(root,'files'),name:'Process main',capabilities:[FILE_APPEND],hostUrl:initial.deviceURL,hostCertPath:join(root,'host-cert.pem'),hostFingerprint:hostIdentity.fingerprint}),{mode:0o600});
  const child=spawnWithMaterialPipe(process.execPath,[join(composition,'tests/fixtures/current-real-browser-agent.mjs'),'--config',config],{env:{...env,DEXTER_FIXTURE_ROOT:root,DEXTER_FIXTURE_COMPOSITION:composition,DEXTER_FIXTURE_NATIVE:peer.options.executable,DEXTER_FIXTURE_GATE:'no'},stdio:'pipe'},peer.material);let output='',stderr='';child.stdout.on('data',x=>{output+=x;appendFileSync(join(root,'daemon-'+child.pid+'.stdout.log'),x,{mode:0o600});});child.stderr.on('data',x=>{stderr+=x;appendFileSync(join(root,'daemon-'+child.pid+'.stderr.log'),x,{mode:0o600});});const exited=new Promise(done=>child.once('close',(code,signal)=>{log('daemon-process-events.jsonl',{event:'close',pid:child.pid,code,signal,stderrBytes:stderr.length});done({code,signal});}));daemonPIDs.push(child.pid);log('daemon-process-events.jsonl',{event:'spawn',pid:child.pid});
  const instance={pid:child.pid,async stop(){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const result=await exited;clearTimeout(timer);assert.ok(result.code===0||result.code===3);assert.equal(stderr,'');assert.throws(()=>process.kill(child.pid,0),e=>e.code==='ESRCH');}};
  if(revoked){const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const result=await exited;clearTimeout(timer);assert.ok(result.code===0||result.code===3);assert.equal(stderr,'');assert.ok(output.includes('forbidden'));assert.throws(()=>process.kill(child.pid,0),e=>e.code==='ESRCH');return {pid:child.pid,refused:true};}
  daemon=instance;await until(async()=>{const status=await host.command('polls',{mainID:peer.deviceId});return output.includes('"ready"')&&status.polls.some(p=>p.status===200&&p.fingerprint===peer.loaded.fingerprint&&p.certificateDER===peer.loaded.certificateDER)&&status.mainPresence==='online';});return instance;
 }
 async function cleanup(){if(cleaned)return;cleaned=true;await daemon?.stop();daemon=null;if(host){await host.stop();host=null;}for(const restore of restores.reverse())restore();}
 process.on('SIGTERM',()=>void cleanup().then(()=>process.exit(0)).catch(()=>process.exit(2)));
 const send=value=>process.stdout.write(JSON.stringify(bounded(value))+'\n');
 try{
  host=new HostProcess({app:0,device:0});hosts.push(host.pid);initial=await host.ready;assert.equal(initial.pid,host.pid);assert.deepEqual(leases(),[host.pid]);
  // Genuine contender in another Node process: the production HostStore rejects while Host1 owns the lease.
  assert.throws(()=>new HostStore({dataDir:join(root,'store')}),e=>e.code==='host_locked');
  const main=await pairPeer('main'),revoked=await pairPeer('revoked');await startDaemon(main);
  const bundle=await host.command('app_bundle');send({bundle,hostPID:host.pid,hostID:initial.hostID,ownerID:initial.ownerID,hostFingerprint:hostIdentity.fingerprint,agentID:main.deviceId,agentFingerprint:main.loaded.fingerprint,agentDER:main.loaded.certificateDER,revokedID:revoked.deviceId});
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input){
   try{assert.ok(Buffer.byteLength(line)<=65536);const c=JSON.parse(line);let result;
    if(c.op==='approve')result=await host.command('approve',{claimID:c.claimID,fingerprint:c.fingerprint});
    else if(c.op==='prepare'){ids={botID:c.botID,threadID:c.threadID,appID:c.appID,mainID:main.deviceId,revokedID:revoked.deviceId};before=await host.command('prepare',ids);result=before;}
    else if(c.op==='restart'){
     assert.ok(before);const bindingMain=readFileSync(join(main.dataDir,'binding.json')),bindingRevoked=readFileSync(join(revoked.dataDir,'binding.json'));
     const oldPID=host.pid;await daemon.stop();daemon=null;await host.stop();host=null;assert.deepEqual(leases(),[]);log('host-process-events.jsonl',{event:'first-dead-before-second-spawn',pid:oldPID,leaseRows:0});
     host=new HostProcess({app:Number(new URL(initial.appURL).port),device:Number(new URL(initial.deviceURL).port)});hosts.push(host.pid);const next=await host.ready;assert.notEqual(next.pid,oldPID);assert.equal(next.pid,host.pid);assert.equal(next.hostID,initial.hostID);assert.equal(next.ownerID,initial.ownerID);assert.equal(next.appURL,initial.appURL);assert.equal(next.deviceURL,initial.deviceURL);assert.deepEqual(next.authority,initial.authority);assert.deepEqual(leases(),[host.pid]);
     assert.deepEqual(readFileSync(join(main.dataDir,'binding.json')),bindingMain);assert.deepEqual(readFileSync(join(revoked.dataDir,'binding.json')),bindingRevoked);
     await startDaemon(main);const polls=await host.command('polls',{mainID:main.deviceId}),peer=polls.polls.find(p=>p.status===200&&p.fingerprint===main.loaded.fingerprint);assert.equal(peer.certificateDER,main.loaded.certificateDER);assert.equal(peer.protocol,'TLSv1.3');assert.equal(peer.resumed,false);
     const refused=await startDaemon(revoked,true);assert.equal(refused.refused,true);
     const refusalPolls=(await host.command('polls',{mainID:main.deviceId})).polls;const refusedPeer=refusalPolls.find(p=>p.fingerprint===revoked.loaded.fingerprint&&p.status===403);assert.ok(refusedPeer,'real revoked peer mTLS request refused HTTP403');assert.equal(refusedPeer.certificateDER,revoked.loaded.certificateDER);assert.equal(refusedPeer.protocol,'TLSv1.3');
     const after=await host.command('after_restart',{...ids,before});
     result={before,after,hostPIDs:hosts,daemonPIDs,firstDeadBeforeSecondWriter:true,betweenLeaseRows:0,currentLeasePID:leases()[0],hostPin:hostIdentity.fingerprint,agentPeer:peer,revokedDaemonRefused:true,revokedPeer:refusedPeer,sameBindings:true,sameEndpoints:true,driverTurns:0};
     writeFileSync(join(root,'host-process-observation.json'),JSON.stringify(result,null,2),{mode:0o600});
    }else if(c.op==='stop'){await cleanup();assert.deepEqual(leases(),[]);result={writerReleased:true,hostPIDs:hosts,daemonPIDs};send(result);input.close();break;}
    else throw Error('closed supervisor command');send(result);
   }catch{send({fixtureError:'host_process_refused'});}
  }
  await cleanup();
 }catch{await cleanup();process.stderr.write('Host process fixture refused\n');process.exitCode=2;}
}
