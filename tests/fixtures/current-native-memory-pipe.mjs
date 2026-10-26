// TEST ONLY: ephemeral synthetic identity transport. Never a production custody provider.
import childProcess from 'node:child_process';
import {readSync,fstatSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const MAX_BYTES=32768;
export function readMaterialPipe(fd=3){
 const chunks=[];let total=0,bytes;
 try{
  const stat=fstatSync(fd);if(!stat.isFIFO()&&!stat.isSocket())throw Error();
  for(;;){const b=Buffer.alloc(4096),n=readSync(fd,b,0,b.length,null);if(n===0){b.fill(0);break;}total+=n;if(total>MAX_BYTES){b.fill(0);throw Error();}chunks.push(b.subarray(0,n));}
  bytes=Buffer.concat(chunks);const value=JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(value).sort(),['certificateDER','fixtureMarker','privateKeyX963']);
  assert.equal(value.fixtureMarker,'dexter-native-cli-forwarding-laboratory-v1');
  assert.equal(typeof value.privateKeyX963,'string');assert.equal(typeof value.certificateDER,'string');
  assert.equal(Buffer.from(value.privateKeyX963,'base64').length,97);assert.ok(Buffer.from(value.certificateDER,'base64').length<=16384);
  return value;
 }catch{throw Error('Synthetic identity pipe refused');}
 finally{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);}
}
function encodeMaterial(material){
 const bytes=Buffer.from(JSON.stringify(material));if(bytes.length>MAX_BYTES){bytes.fill(0);throw Error('Synthetic identity material exceeds bound');}return bytes;
}
function writeBytes(stream,bytes){try{stream.on('error',()=>{});stream.end(bytes,()=>bytes.fill(0));}catch(error){bytes.fill(0);throw error;}}
export function writeMaterialPipe(stream,material){writeBytes(stream,encodeMaterial(material));}
function spawnMaterial(original,command,args,options,material){
 const streams=options.stdio==='pipe'?['pipe','pipe','pipe']:options.stdio;
 assert.ok(Array.isArray(streams)&&streams.length===3&&streams.every(x=>x==='pipe'),'exact original RPC streams required');
 const bytes=encodeMaterial(material);let child;
 try{child=original(command,args,{...options,stdio:[...streams,'pipe']});}catch(error){bytes.fill(0);throw error;}
 writeBytes(child.stdio[3],bytes);return child;
}
export function spawnWithMaterialPipe(command,args,options,material){return spawnMaterial(childProcess.spawn,command,args,options,material);}
export function installNativeMaterialPipe(executable,material,onChild=()=>{}){
 const original=childProcess.spawn;
 childProcess.spawn=function(command,args,options){
  if(command!==executable)return original(command,args,options);
  const child=spawnMaterial(original,command,args,options,material);onChild(child,args,options);return child;
 };
 syncBuiltinESMExports();
 return ()=>{childProcess.spawn=original;syncBuiltinESMExports();};
}
