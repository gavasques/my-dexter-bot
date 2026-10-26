// TEST ONLY. Explicit inherited memory material; never a production custody provider.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {createPrivateKey,X509Certificate} from 'node:crypto';
import {closeSync,fstatSync,readSync,realpathSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {inspect} from 'node:util';

const MAX=32768;
const MARKERS=new Set(['dexter-native-cli-forwarding-laboratory-v1','dexter-native-client-laboratory-v1']);
const wrappers=new WeakMap();
const refused=()=>new Error('Native laboratory memory transport refused');
function exact(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw refused();
 if(Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0'))throw refused();
 return value;
}
function base64(value,max){
 if(typeof value!=='string'||value.length>Math.ceil(max/3)*4)throw refused();
 const bytes=Buffer.from(value,'base64');
 if(bytes.length>max||bytes.toString('base64')!==value){bytes.fill(0);throw refused();}
 return bytes;
}
export function validateNativeMaterial(material){
 exact(material,['fixtureMarker','privateKeyX963','certificateDER']);
 if(!MARKERS.has(material.fixtureMarker))throw refused();
 const raw=base64(material.privateKeyX963,97);let der;
 try{
  der=base64(material.certificateDER,16384);
  if(raw.length!==97||raw[0]!==4||!der.length)throw refused();
  const key=createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:raw.subarray(1,33).toString('base64url'),y:raw.subarray(33,65).toString('base64url'),d:raw.subarray(65).toString('base64url')}});
  const certificate=new X509Certificate(der);
  if(!certificate.raw.equals(der)||!certificate.checkPrivateKey(key))throw refused();
  return material;
 }catch{throw refused();}finally{raw.fill(0);}
}
export function nativeMaterial(identity,marker='dexter-native-cli-forwarding-laboratory-v1'){
 if(!MARKERS.has(marker))throw refused();
 const key=createPrivateKey(identity.keyPem),cert=new X509Certificate(identity.certPem);
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||!cert.checkPrivateKey(key))throw refused();
 const jwk=key.export({format:'jwk'}),parts=[jwk.x,jwk.y,jwk.d].map(v=>base64url(v)),raw=Buffer.concat([Buffer.from([4]),...parts]);
 try{return validateNativeMaterial({fixtureMarker:marker,privateKeyX963:raw.toString('base64'),certificateDER:cert.raw.toString('base64')});}
 finally{raw.fill(0);for(const part of parts)part.fill(0);}
}
function base64url(value){
 if(typeof value!=='string')throw refused();
 const bytes=Buffer.from(value,'base64url');
 if(bytes.length!==32||bytes.toString('base64url')!==value){bytes.fill(0);throw refused();}
 return bytes;
}
function encode(value){const bytes=Buffer.from(JSON.stringify(value));if(!bytes.length||bytes.length>MAX){bytes.fill(0);throw refused();}return bytes;}
function write(stream,bytes){
 try{assert.ok(stream&&typeof stream.end==='function');stream.once('error',()=>bytes.fill(0));stream.end(bytes,()=>bytes.fill(0));}
 catch{bytes.fill(0);throw refused();}
}
function spawnMaterial(original,command,args,options,material,holdOutputPipe=false){
 validateNativeMaterial(material);if(typeof holdOutputPipe!=='boolean')throw refused();
 const streams=options.stdio==='pipe'?['pipe','pipe','pipe']:options.stdio;
 if(!Array.isArray(streams)||streams.length!==3||!streams.every(x=>x==='pipe'))throw refused();
 const bytes=encode(material),control=encode({holdOutputPipe});let child;
 try{child=original(command,args,{...options,stdio:[...streams,'pipe','pipe']});}
 catch{bytes.fill(0);control.fill(0);throw refused();}
 try{write(child.stdio[3],bytes);write(child.stdio[4],control);return child;}
 catch{child.kill('SIGKILL');throw refused();}
}
export function spawnWithNativeMemoryMaterial(command,args,options,material,holdOutputPipe=false){
 return spawnMaterial(childProcess.spawn,command,args,options,material,holdOutputPipe);
}
function readJsonPipe(fd){
 const chunks=[];let bytes,total=0;
 try{
  const info=fstatSync(fd);if(!info.isFIFO()&&!info.isSocket())throw refused();
  for(;;){const chunk=Buffer.alloc(4096),n=readSync(fd,chunk,0,chunk.length,null);if(!n){chunk.fill(0);break;}total+=n;if(total>MAX){chunk.fill(0);throw refused();}chunks.push(chunk.subarray(0,n));}
  bytes=Buffer.concat(chunks);if(!bytes.length)throw refused();return JSON.parse(bytes.toString('utf8'));
 }catch{throw refused();}finally{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);try{closeSync(fd);}catch{}}
}
export function readNativeMaterialPipe(fd=3){return validateNativeMaterial(readJsonPipe(fd));}
export function readNativeControlPipe(fd=4){const value=exact(readJsonPipe(fd),['holdOutputPipe']);if(typeof value.holdOutputPipe!=='boolean')throw refused();return value;}
export function installNativeMemoryTransport(executable){
 const canonical=realpathSync(executable);if(canonical!==executable)throw refused();
 const original=childProcess.spawn,entries=new Map();let closed=false;
 const wrapper=function(command,args,options){
  if(command!==canonical)return original(command,args,options);
  if(closed||!Array.isArray(args)||args.length!==2||args[0]!=='--config')throw refused();
  const entry=entries.get(args[1]);if(!entry)throw refused();
  return spawnMaterial(original,command,args,options,entry.material,entry.holdOutputPipe);
 };
 wrappers.set(wrapper,{original,isClosed:()=>closed});
 childProcess.spawn=wrapper;syncBuiltinESMExports();
 const transport={
  register(configPath,identity,marker='dexter-native-cli-forwarding-laboratory-v1'){return this.registerMaterial(configPath,nativeMaterial(identity,marker));},
  registerMaterial(configPath,material){if(closed||realpathSync(configPath)!==configPath)throw refused();entries.set(configPath,{material:validateNativeMaterial(material),holdOutputPipe:false});},
  holdPipe(configPath,holdOutputPipe){const entry=entries.get(configPath);if(closed||!entry||typeof holdOutputPipe!=='boolean')throw refused();entry.holdOutputPipe=holdOutputPipe;},
  envelope(configPath){const entry=entries.get(configPath);if(closed||!entry)throw refused();return encode({executable:canonical,configPath,material:entry.material});},
  restore(){
   if(closed)return;
   let cursor=childProcess.spawn;while(cursor!==wrapper&&wrappers.has(cursor))cursor=wrappers.get(cursor).original;
   if(cursor!==wrapper)throw new Error('Native laboratory spawn wrapper ownership changed');
   closed=true;entries.clear();
   if(childProcess.spawn===wrapper){let next=original;while(wrappers.get(next)?.isClosed())next=wrappers.get(next).original;childProcess.spawn=next;syncBuiltinESMExports();}
  },
  toJSON(){return {closed,configurations:entries.size};},
  [inspect.custom](){return this.toJSON();}
 };
 return transport;
}
export function installInheritedNativeMemoryTransport(fd=3){
 const envelope=exact(readJsonPipe(fd),['executable','configPath','material']);
 if(typeof envelope.executable!=='string'||typeof envelope.configPath!=='string'||envelope.executable.length>4096||envelope.configPath.length>4096)throw refused();
 const transport=installNativeMemoryTransport(envelope.executable);
 try{transport.registerMaterial(envelope.configPath,envelope.material);return transport;}
 catch{transport.restore();throw refused();}
}
// Temporary DER/JSON buffers are wiped; retained JS strings/OpenSSL copies are not wipeable.
