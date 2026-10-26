// Explicit LAB: actual unchanged CLI Main + real request/transport; synthetic inherited-pipe memory identity, NOT Keychain custody.
import assert from 'node:assert/strict';
import childProcess, {spawn} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {HostStore} from '@dexter/hub';
import {DeviceHostServer,DevicePairingRegistry,MacDeviceDaemon,pairDevice,readBinding,DeviceError,FILE_APPEND,createLabTlsIdentity} from '../packages/devices/dist/index.js';
import {NativeDeviceClient} from '../packages/devices/dist/native-client.js';
import {readDaemonConfig,bindNativeDevice} from '../packages/devices/dist/daemon-config.js';
import {installNativeMemoryTransport} from './fixtures/native-swift-memory-pipe.mjs';
const code=c=>e=>e instanceof DeviceError&&e.code===c;
const policy='cli_forwarding_laboratory_memory_only';
async function until(check,ms=20000){const end=Date.now()+ms;while(!check()){assert.ok(Date.now()<end,'bounded owned barrier');await new Promise(r=>setTimeout(r,10));}}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function identity(root,name,san='IP:127.0.0.1',client=false){
 const dir=join(root,name);mkdirSync(dir,{mode:0o700});
 const value=createLabTlsIdentity({profile:client?'client':'host',name:'synthetic-'+name,san:[san]}).identity;
 writeFileSync(join(dir,'cert.pem'),value.certPem,{mode:0o600});return value;
}
async function laboratory(t,san='IP:127.0.0.1'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-native-bridge-honest-')));chmodSync(root,0o700);
 const host=identity(root,'host',san),peer=identity(root,'peer','DNS:synthetic-client',true),other=identity(root,'other','DNS:synthetic-other',true);
 assert.ok(process.env.DEXTER_SWIFT_CLI_LAB_EXECUTABLE,'explicit actual CLI laboratory executable');const executable=join(root,'actual-cli');copyFileSync(process.env.DEXTER_SWIFT_CLI_LAB_EXECUTABLE,executable);chmodSync(executable,0o700);
 const memory=installNativeMemoryTransport(executable);let setupComplete=false;t.after(()=>{if(!setupComplete)memory.restore();});
 const material=(config,id)=>memory.register(config,id);
 const store=new HostStore({dataDir:join(root,'store')}),registry=new DevicePairingRegistry(store);let tcp=0,http=0,nativeServer;const sessions=[];
 const original=https.createServer;https.createServer=(...args)=>{const server=original(...args);nativeServer=server;server.on('connection',()=>tcp++);server.on('request',()=>http++);server.on('secureConnection',s=>sessions.push({protocol:s.getProtocol(),resumed:s.isSessionReused(),fingerprint:new X509Certificate(s.getPeerCertificate().raw).fingerprint256.replaceAll(':','').toLowerCase()}));return server;};syncBuiltinESMExports();
 let server;try{server=new DeviceHostServer({store,registry,identity:host,pollWaitMs:80,receiptTimeoutMs:20000});}finally{https.createServer=original;syncBuiltinESMExports();}
 const hostURL=await server.start(),trust={hostUrl:hostURL,hostCertPem:host.certPem,hostFingerprint:host.fingerprint};const clients=[],children=[];let n=0;
 const configFor=(pin=host)=>{const configPath=join(root,'helper-'+n+++'.json');const config={installationID:store.hostId,laboratoryID:'0123456789abcdef0123456789abcdef',hostURL,hostCertificateDER:new X509Certificate(pin.certPem).raw.toString('base64'),hostFingerprint:pin.fingerprint};writeFileSync(configPath,JSON.stringify(config),{mode:0o600});material(configPath,peer);return {configPath,config};};
 const client=(entry=configFor(),identityMode='laboratory-native')=>{const c=new NativeDeviceClient({executable,configPath:entry.configPath,installationID:store.hostId,...(identityMode===undefined?{}:{identityMode})});clients.push(c);return {c,...entry};};
 const dataDir=join(root,'agent'),fixtureRoot=join(root,'effects');mkdirSync(dataDir,{mode:0o700});mkdirSync(fixtureRoot,{mode:0o700});const entry=configFor();
 const daemonConfig={mode:'laboratory',version:2,dataDir,name:'Honest Native LAB',capabilities:[FILE_APPEND],hostUrl:hostURL,hostCertPath:join(root,'host/cert.pem'),hostFingerprint:host.fingerprint,fixtureRoot,client:{kind:'native-helper',executable,configPath:entry.configPath,installationID:store.hostId,identityMode:'laboratory-native'}};
 const daemonPath=join(root,'daemon.json');writeFileSync(daemonPath,JSON.stringify(daemonConfig),{mode:0o600});
 const counts=p=>existsSync(p+'.memory-fixture.counts')?readFileSync(p+'.memory-fixture.counts','utf8').trim().split('\n'):[];
 const daemon=(held=false,pairing)=>{const child=spawn(process.execPath,['--import',resolve('tests/fixtures/native-bridge-memory-preload.mjs'),resolve(held?'tests/fixtures/native-bridge-held-daemon.mjs':'packages/devices/dist/daemon-main.js'),'--config',daemonPath,...(pairing?['--pair']:[])],{env:{PATH:'/usr/bin:/bin',NODE_NO_WARNINGS:'1'},cwd:process.cwd(),stdio:['pipe','pipe','pipe','pipe']});const envelope=memory.envelope(entry.configPath);child.stdio[3].once('error',()=>envelope.fill(0));child.stdio[3].end(envelope,()=>envelope.fill(0));let stdout='',stderrBytes=0,done=false;const closed=new Promise(resolve=>child.once('close',(exit,signal)=>{done=true;resolve({exit,signal});}));child.stdout.on('data',b=>{stdout+=b;assert.ok(stdout.length<65536);});child.stderr.on('data',b=>{stderrBytes+=b.length;assert.ok(stderrBytes<16384);});child.stdin.on('error',()=>{});if(pairing)child.stdin.end(JSON.stringify({offerId:pairing.offerId,code:pairing.code})+'\n');else child.stdin.end();const value={child,closed,done:()=>done,events:()=>stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)),stderrBytes:()=>stderrBytes};children.push(value);return value;};
 t.after(async()=>{for(const d of children){if(!d.done())d.child.kill('SIGKILL');await d.closed;}for(const c of clients)await c.close();await server.close();registry.close();store.close();memory.restore();rmSync(root,{recursive:true,force:true});});
 const bot=store.createBot({name:'LAB bot',profileId:'laboratory',engine:'claude'}),thread=store.createThread(bot.id);
 const action=(deviceId,line,key)=>store.requestAction({botId:bot.id,threadId:thread.id,tool:FILE_APPEND,destination:deviceId,arguments:{name:'notes.txt',line},idempotencyKey:key});
 setupComplete=true;return {root,host,peer,other,material,store,registry,server,nativeServer,trust,client,configFor,entry,executable,dataDir,fixtureRoot,daemonConfig,daemonPath,daemon,counts,bot,thread,action,sessions,counters:()=>({tcp,http})};
}
async function pair(l,c){bindNativeDevice(l.dataDir,(await c.loadOnly(20000)).fingerprint);const offer=l.server.pairingBundle({kind:'pair'});const p=pairDevice({dataDir:l.dataDir,client:c,trust:l.trust,offerId:offer.offerId,code:offer.code,name:'Honest LAB',capabilities:[FILE_APPEND],timeoutMs:20000,pollIntervalMs:30});await until(()=>l.registry.listPendingClaims().length===1);l.registry.approveClaim(l.registry.listPendingClaims()[0].claimId);return p;}
async function startPaired(l,held=false){const d=l.daemon(held);await until(()=>d.done()||d.events().some(e=>e.event==='ready'));assert.equal(d.done(),false,JSON.stringify(d.events()));await until(()=>l.server.authenticatedPresence(readBinding(l.dataDir).deviceId)==='online');return d;}
async function stop(d,signal='SIGTERM'){d.child.kill(signal);const status=await d.closed;assert.equal(status.exit,0);assert.equal(alive(d.child.pid),false);assert.ok(d.events().some(e=>e.event==='stopped'));return status;}
function journal(l,sql,params=[]){const db=new DatabaseSync(join(l.dataDir,'journal.sqlite'));try{return db.prepare(sql).get(...params);}finally{db.close();}}

test('explicit LAB policy only: default native rejects truthful actual CLI, namespace and literal loopback required',async t=>{
 const l=await laboratory(t),entry=l.configFor();const prod=new NativeDeviceClient({executable:l.executable,configPath:entry.configPath,installationID:l.store.hostId});t.after(()=>prod.close());await assert.rejects(prod.loadOnly(20000),code('protocol_error'));assert.deepEqual(l.counters(),{tcp:0,http:0});
 const {c}=l.client(entry);const a=await c.loadOnly(20000);assert.equal(a.policy,policy);assert.equal(a.fingerprint,l.peer.fingerprint);assert.equal(Object.isFrozen(a),true);assert.equal((await c.loadOnly(20000)).certificateDER,a.certificateDER);assert.ok(l.counts(entry.configPath).every(x=>x==='load'));
 for(const url of ['https://example.test/','https://localhost/','https://127.1/','https://2130706433/','http://127.0.0.1/']){const e=l.configFor();writeFileSync(e.configPath,JSON.stringify({...e.config,hostURL:url}),{mode:0o600});assert.throws(()=>l.client(e),e=>e instanceof DeviceError);}
 const e=l.configFor();delete e.config.laboratoryID;writeFileSync(e.configPath,JSON.stringify(e.config),{mode:0o600});assert.throws(()=>l.client(e),code('forbidden'));
 for(const identityMode of [true,'memory','',null])assert.throws(()=>new NativeDeviceClient({executable:l.executable,configPath:entry.configPath,installationID:l.store.hostId,identityMode}),code('invalid_input'));
 for(const hostURL of ['https://127.0.0.1/','https://[::1]/']){const e=l.configFor();writeFileSync(e.configPath,JSON.stringify({...e.config,hostURL}),{mode:0o600});await l.client(e).c.loadOnly(20000);}
 assert.equal(readDaemonConfig(l.daemonPath).client.identityMode,'laboratory-native');
 for(const hostURL of ['https://example.test/','https://localhost/','https://127.1/']){const e=l.configFor();writeFileSync(e.configPath,JSON.stringify({...e.config,hostURL}),{mode:0o600});writeFileSync(l.daemonPath,JSON.stringify({...l.daemonConfig,hostUrl:hostURL,client:{...l.daemonConfig.client,configPath:e.configPath}}),{mode:0o600});assert.throws(()=>readDaemonConfig(l.daemonPath),code('forbidden'));}
 const local={...l.daemonConfig,mode:'local-capabilities',capabilities:['mac.browser.navigate'],policyPath:join(l.root,'policy.json'),browser:null,cua:null};delete local.fixtureRoot;writeFileSync(l.daemonPath,JSON.stringify(local),{mode:0o600});assert.throws(()=>readDaemonConfig(l.daemonPath),code('forbidden'));
 const pinned=l.client(l.configFor());await pinned.c.loadOnly(20000);writeFileSync(pinned.configPath,JSON.stringify({...pinned.config,laboratoryID:'1'.repeat(32)}),{mode:0o600});await assert.rejects(pinned.c.post('device/poll',{deviceId:'dev_missing',installationId:l.store.hostId,receipts:[]},20000),code('forbidden'));
 assert.deepEqual(l.counters(),{tcp:0,http:0});
});

test('real separated daemon pairs, appends, restarts same DER/fingerprint/deviceID; no grants and revoked startup/dispatch refused',async t=>{
 const l=await laboratory(t),offer=l.server.pairingBundle({kind:'pair'}),d=l.daemon(false,offer);await until(()=>l.registry.listPendingClaims().length===1);const claim=l.registry.listPendingClaims()[0];assert.equal(claim.clientFingerprint,l.peer.fingerprint);l.registry.approveClaim(claim.claimId);await until(()=>d.events().some(e=>e.event==='ready'));const binding=readBinding(l.dataDir);await until(()=>l.server.authenticatedPresence(binding.deviceId)==='online');
 l.store.setGrant({botId:l.bot.id,tool:FILE_APPEND,destination:binding.deviceId,policy:'allow'});const action=l.action(binding.deviceId,'one-actual-cli','once');assert.equal((await l.server.dispatch(action.id)).state,'succeeded');assert.equal(readFileSync(join(l.fixtureRoot,'notes.txt'),'utf8'),'one-actual-cli\n');await stop(d);
 const {c}=l.client(l.entry);const a=await c.loadOnly(20000);await c.close();const {c:b}=l.client(l.entry);const again=await b.loadOnly(20000);assert.deepEqual(again,a);assert.equal(a.policy,policy);assert.equal(a.fingerprint,l.peer.fingerprint);
 const restart=await startPaired(l);assert.deepEqual(readBinding(l.dataDir),binding);assert.equal(JSON.parse(readFileSync(join(l.dataDir,'native-device.json'))).fingerprint,a.fingerprint);
 const outsider=l.store.createBot({name:'No grants',profileId:'laboratory',engine:'claude'}),thread=l.store.createThread(outsider.id);assert.throws(()=>l.store.requestAction({botId:outsider.id,threadId:thread.id,tool:FILE_APPEND,destination:binding.deviceId,arguments:{name:'notes.txt',line:'forbidden'},idempotencyKey:'no-grant'}),e=>e.code==='forbidden');
 const queued=l.action(binding.deviceId,'revoked-must-not-append','revoked');l.server.revokeDevice(binding.deviceId);await assert.rejects(l.server.dispatch(queued.id),e=>e.code==='conflict');assert.equal(l.store.getAction(queued.id).state,'blocked');await until(()=>restart.done());assert.equal((await restart.closed).exit,3);
 const revoked=l.daemon();await until(()=>revoked.done());assert.equal((await revoked.closed).exit,3);assert.ok(revoked.events().some(e=>e.event==='stopped'&&e.reason==='forbidden'));assert.equal(readFileSync(join(l.fixtureRoot,'notes.txt'),'utf8'),'one-actual-cli\n');
 assert.ok(l.sessions.length>=5);assert.ok(l.sessions.every(s=>s.protocol==='TLSv1.3'&&!s.resumed&&s.fingerprint===l.peer.fingerprint));assert.ok(l.counts(l.entry.configPath).every(x=>x==='load'));
});

test('actual Main receives immutable expected fingerprint: swapped memory identity refuses at zero TCP',async t=>{
 const l=await laboratory(t),{c,configPath}=l.client();await c.loadOnly(20000);const before=l.counters();l.material(configPath,l.other);await assert.rejects(c.post('device/poll',{deviceId:'dev_missing',installationId:l.store.hostId,receipts:[]},20000),code('conflict'));assert.deepEqual(l.counters(),before);assert.equal(c.pending,0);
});

test('actual Swift transport enforces host pin and IP SAN before HTTP',async t=>{
 for(const kind of ['pin','SAN']){const l=await laboratory(t,kind==='SAN'?'DNS:wrong.example':'IP:127.0.0.1'),{c}=l.client(l.configFor(kind==='pin'?l.other:l.host));await c.loadOnly(20000);await assert.rejects(c.post('device/poll',{deviceId:'dev_missing',installationId:l.store.hostId,receipts:[]},20000),code('tls_pin_mismatch'));assert.equal(l.counters().http,0);}
});

test('effect-before-crash becomes durable unknown on process restart and is never appended again',async t=>{
 const l=await laboratory(t),{c}=l.client(l.entry);await c.loadOnly(20000);const binding=await pair(l,c);await c.close();l.store.setGrant({botId:l.bot.id,tool:FILE_APPEND,destination:binding.deviceId,policy:'allow'});
 const d=await startPaired(l,true),action=l.action(binding.deviceId,'unknown-once','unknown-case');const dispatch=l.server.dispatch(action.id);await until(()=>existsSync(join(l.fixtureRoot,'effect-barrier.json')));assert.equal(readFileSync(join(l.fixtureRoot,'notes.txt'),'utf8'),'unknown-once\n');assert.equal(journal(l,'SELECT status FROM receipts WHERE action_id=?',[action.id]).status,'started');d.child.kill('SIGKILL');assert.equal((await d.closed).signal,'SIGKILL');
 const restarted=await startPaired(l);assert.equal((await dispatch).state,'unknown');await until(()=>journal(l,'SELECT status,acked FROM receipts WHERE action_id=?',[action.id]).acked===1);assert.equal(journal(l,'SELECT status FROM receipts WHERE action_id=?',[action.id]).status,'unknown');const tcp=l.counters().tcp;await assert.rejects(l.server.dispatch(action.id),e=>e.code==='conflict');assert.equal(l.store.getAction(action.id).state,'unknown');await until(()=>l.counters().tcp>tcp);assert.equal(readFileSync(join(l.fixtureRoot,'notes.txt'),'utf8'),'unknown-once\n');await stop(restarted,'SIGINT');
});

test('held actual Swift helper close waits real child exit; signals drain real daemon and no late result/redelivery',async t=>{
 const l=await laboratory(t),{c}=l.client(l.entry);await c.loadOnly(20000);const binding=await pair(l,c);let held=false,release;
 l.nativeServer.prependListener('request',(req,res)=>{if(req.url!=='/v1/device/poll')return;const end=res.end;res.end=function(...args){held=true;release=()=>end.apply(res,args);return res;};});
 const original=childProcess.spawn,helpers=[];childProcess.spawn=(...args)=>{const child=original(...args);if(args[0]===l.executable){const entry={pid:child.pid,closed:false};helpers.push(entry);child.once('close',()=>entry.closed=true);}return child;};syncBuiltinESMExports();let result,closing;
 try{result=c.post('device/poll',{deviceId:binding.deviceId,installationId:l.store.hostId,receipts:[]},20000).then(v=>v,e=>e);await until(()=>held);assert.equal(helpers.length,1);assert.equal(c.pending,1);assert.equal(helpers[0].closed,false);closing=c.close();assert.equal(c.close(),closing);await assert.rejects(c.post('device/poll',{deviceId:binding.deviceId,installationId:l.store.hostId,receipts:[]},20000),code('unavailable'));const out=await result;assert.ok(out instanceof DeviceError);assert.equal(out.code,'outcome_unknown');await closing;assert.equal(c.pending,0);assert.equal(helpers[0].closed,true);assert.equal(alive(helpers[0].pid),false);release?.();}finally{childProcess.spawn=original;syncBuiltinESMExports();await closing;}
 // Subsequent daemon termination occurs while its real helper is held; no fake client or close hook.
 held=false;const d=await startPaired(l);await until(()=>held);d.child.kill('SIGTERM');d.child.kill('SIGINT');const status=await d.closed;assert.equal(status.exit,0);assert.ok(d.events().some(e=>e.event==='stopped'));assert.equal(alive(d.child.pid),false);release?.();
});
