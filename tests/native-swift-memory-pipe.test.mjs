// Transport metadata only; does not claim actual Swift, TLS composition or custody.
import assert from 'node:assert/strict';
import childProcess,{execFileSync} from 'node:child_process';
import {createPrivateKey,generateKeyPairSync,X509Certificate} from 'node:crypto';
import {mkdtempSync,openSync,closeSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {inspect} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {installNativeMemoryTransport,nativeMaterial,spawnWithNativeMemoryMaterial} from './fixtures/native-swift-memory-pipe.mjs';

const helper=new URL('./fixtures/native-swift-memory-pipe.mjs',import.meta.url).href;
function identity(){
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const der=privateKey.export({type:'pkcs8',format:'der'});
 let keyPem,certPem;
 try{
  keyPem=createPrivateKey({key:der,format:'der',type:'pkcs8'}).export({type:'pkcs8',format:'pem'});
  certPem=execFileSync('/usr/bin/openssl',['req','-new','-x509','-key','/dev/stdin','-days','1','-subj','/CN=MemoryTransportMetadata','-addext','subjectAltName=IP:127.0.0.1','-addext','basicConstraints=critical,CA:FALSE'],{input:keyPem,env:{},encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:5000});
 }catch{throw Error('Synthetic memory certificate fixture refused');}finally{der.fill(0);}
 return {keyPem,certPem};
}
async function collect(child,input='{}'){
 let stdout='',stderrBytes=0;const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>32768)child.kill('SIGKILL');});
 child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>8192)child.kill('SIGKILL');});
 child.stdin.on('error',()=>{});child.stdin.end(input);
 try{return await new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('Owned metadata child start refused')));child.once('close',(exit,signal)=>resolve({exit,signal,stderrBytes,stdout}));});}
 finally{clearTimeout(timer);}
}
const receiver=`import {readNativeMaterialPipe,readNativeControlPipe} from ${JSON.stringify(helper)};import {X509Certificate} from 'node:crypto';const material=readNativeMaterialPipe();const control=readNativeControlPipe();let rpc='';for await(const b of process.stdin)rpc+=b;if(rpc.length>1024)throw Error('RPC metadata bound');process.stdout.write(JSON.stringify({fingerprint:new X509Certificate(Buffer.from(material.certificateDER,'base64')).fingerprint256,control,rpc:JSON.parse(rpc)}));`;
function run(material,control=false){return spawnWithNativeMemoryMaterial(process.execPath,['--input-type=module','--eval',receiver],{env:{},stdio:'pipe'},material,control);}

test('FD3 identity and FD4 non-secret control preserve all three RPC streams in a separate process',async()=>{
 const id=identity(),result=await collect(run(nativeMaterial(id),true),'{"operation":"load"}');
 assert.equal(result.exit,0);assert.equal(result.signal,null);assert.equal(result.stderrBytes,0);
 const publicResult=JSON.parse(result.stdout);assert.equal(publicResult.fingerprint,new X509Certificate(id.certPem).fingerprint256);
 assert.deepEqual(publicResult.control,{holdOutputPipe:true});assert.deepEqual(publicResult.rpc,{operation:'load'});
 assert.ok(!result.stdout.includes('privateKeyX963'),'child output contains only public metadata');
});
test('swapped key/certificate material is refused before any child is started',()=>{
 const a=identity(),b=identity(),material=nativeMaterial(a),other=nativeMaterial(b);
 assert.throws(()=>run({...material,certificateDER:other.certificateDER}),/transport refused/);
});
test('unknown marker, extra fields and noncanonical or oversized credentials refuse before spawn',()=>{
 const material=nativeMaterial(identity());
 for(const bad of [{...material,fixtureMarker:'production'},{...material,holdOutputPipe:true},{...material,privateKeyX963:material.privateKeyX963+'='},{...material,privateKeyX963:'A'.repeat(100000)}])assert.throws(()=>run(bad),/transport refused/);
});
test('extra inherited streams and non-boolean control are refused without weakening the RPC contract',()=>{
 const material=nativeMaterial(identity());
 assert.throws(()=>spawnWithNativeMemoryMaterial(process.execPath,[],{env:{},stdio:['pipe','pipe','pipe','pipe']},material),/transport refused/);
 assert.throws(()=>run(material,'true'),/transport refused/);
});
test('regular-file sentinel on FD3 is refused, never treated as a credential fallback',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dx-native-meta-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sentinel=join(root,'inert-public-sentinel');writeFileSync(sentinel,'inert public metadata',{mode:0o600});
 const fd=openSync(sentinel,'r');const script=`import {readNativeMaterialPipe} from ${JSON.stringify(helper)};try{readNativeMaterialPipe();process.exitCode=2;}catch{process.stdout.write(JSON.stringify({refused:true}));}`;
 let child;try{child=childProcess.spawn(process.execPath,['--input-type=module','--eval',script],{env:{},stdio:['pipe','pipe','pipe',fd]});}finally{closeSync(fd);}
 const result=await collect(child);assert.equal(result.exit,0);assert.equal(result.stderrBytes,0);assert.deepEqual(JSON.parse(result.stdout),{refused:true});assert.equal(readFileSync(sentinel,'utf8'),'inert public metadata');
});
test('fresh inherited preload receives one exact executable/config binding and redacts its summary',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dx-native-meta-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'public-config.json');writeFileSync(config,'{}',{mode:0o600});
 const transport=installNativeMemoryTransport(realpathSync(process.execPath));let envelope;
 try{transport.register(config,identity());envelope=transport.envelope(config);assert.ok(!JSON.stringify(transport).includes('privateKey'));assert.ok(!inspect(transport).includes('privateKey'));}finally{transport.restore();}
 const script=`import {installInheritedNativeMemoryTransport} from ${JSON.stringify(helper)};const t=installInheritedNativeMemoryTransport();process.stdout.write(JSON.stringify(t));t.restore();`;
 const child=childProcess.spawn(process.execPath,['--input-type=module','--eval',script],{env:{},stdio:['pipe','pipe','pipe','pipe']});
 child.stdio[3].once('error',()=>envelope.fill(0));child.stdio[3].end(envelope,()=>envelope.fill(0));
 const result=await collect(child);assert.equal(result.exit,0);assert.equal(result.stderrBytes,0);assert.deepEqual(JSON.parse(result.stdout),{closed:false,configurations:1});
});
test('an unregistered config cannot use the exact executable wrapper; restoration releases it',()=>{
 const transport=installNativeMemoryTransport(realpathSync(process.execPath));
 try{assert.throws(()=>childProcess.spawn(realpathSync(process.execPath),['--config','/not-registered'],{env:{},stdio:'pipe'}),/transport refused/);}
 finally{transport.restore();}
 assert.deepEqual(transport.toJSON(),{closed:true,configurations:0});
});
test('nested owned wrappers can close in either cleanup order without restoring a closed layer',()=>{
 const original=childProcess.spawn;
 const first=installNativeMemoryTransport(realpathSync('/usr/bin/true'));
 const second=installNativeMemoryTransport(realpathSync(process.execPath));
 try{
  first.restore();assert.equal(first.toJSON().closed,true);
  assert.throws(()=>childProcess.spawn(realpathSync(process.execPath),['--config','/not-registered'],{env:{},stdio:'pipe'}),/transport refused/);
  second.restore();assert.equal(childProcess.spawn,original);
 }finally{second.restore();first.restore();}
});
