import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {mkdtempSync,writeFileSync,openSync,closeSync,rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {installNativeMaterialPipe,writeMaterialPipe} from './fixtures/current-native-memory-pipe.mjs';
const moduleURL=pathToFileURL(new URL('./fixtures/current-native-memory-pipe.mjs',import.meta.url).pathname).href;
const material={fixtureMarker:'dexter-native-cli-forwarding-laboratory-v1',privateKeyX963:Buffer.alloc(97).toString('base64'),certificateDER:Buffer.from('public-synthetic-certificate').toString('base64')};
function ended(child){return new Promise((resolve,reject)=>{let stdout='';child.stdout.on('data',b=>stdout+=b);child.stderr.resume();child.once('error',reject);child.once('close',exit=>resolve({exit,stdout}));});}
test('synthetic pipe adds descriptor3 and preserves the real RPC streams and lifecycle',async()=>{
 let observed=0;const restore=installNativeMaterialPipe(process.execPath,material,(child,args,options)=>{observed++;assert.equal(options.stdio,'pipe');assert.equal(options.shell,false);assert.deepEqual(options.env,{});});
 try{
  const code=`import{readMaterialPipe}from ${JSON.stringify(moduleURL)};import{readFileSync}from'node:fs';const m=readMaterialPipe();const rpc=JSON.parse(readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({operation:rpc.operation,certificateDER:m.certificateDER,privateBytes:Buffer.from(m.privateKeyX963,'base64').length}));`;
  const child=childProcess.spawn(process.execPath,['--input-type=module','-e',code],{stdio:'pipe',shell:false,env:{}}),done=ended(child);child.stdin.end(JSON.stringify({operation:'load'}));
  const result=await done;assert.equal(result.exit,0);assert.deepEqual(JSON.parse(result.stdout),{operation:'load',certificateDER:material.certificateDER,privateBytes:97});assert.equal(observed,1);assert.equal(child.exitCode,0);
 }finally{restore();}
});
test('regular-file descriptor is refused before material decoding',async()=>{
 const root=mkdtempSync('/private/tmp/dexter-public-pipe-'),file=join(root,'public.txt');writeFileSync(file,'public fixture only',{mode:0o600});const fd=openSync(file,'r');
 try{
  const code=`import{readMaterialPipe}from ${JSON.stringify(moduleURL)};try{readMaterialPipe();process.exitCode=7;}catch{process.stdout.write('regular_refused');}`;
  const child=childProcess.spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe',fd],env:{}}),result=await ended(child);child.stdin.end();assert.equal(result.exit,0);assert.equal(result.stdout,'regular_refused');
 }finally{closeSync(fd);rmSync(root,{recursive:true});}
});
test('oversized material is refused before writing to any pipe',()=>{
 let wrote=false;assert.throws(()=>writeMaterialPipe({on(){},end(){wrote=true;}},{...material,certificateDER:'x'.repeat(32769)}));assert.equal(wrote,false);
});

test('target refuses non-pipe RPC stdio before creating a child',()=>{
 const restore=installNativeMaterialPipe(process.execPath,material);try{assert.throws(()=>childProcess.spawn(process.execPath,[],{stdio:'inherit',env:{}}),/exact original RPC streams/);}finally{restore();}
});
test('unrelated command retains its original three streams',async()=>{
 const restore=installNativeMaterialPipe('/public-nonexistent-other-target',material);try{const c=childProcess.spawn(process.execPath,['-e',"process.stdout.write('unrelated')"],{stdio:['ignore','pipe','pipe'],env:{}});assert.equal(c.stdio.length,3);assert.deepEqual(await ended(c),{exit:0,stdout:'unrelated'});}finally{restore();}
});
test('oversized target material is refused before spawning, not only before writing',()=>{
 const original=childProcess.spawn;let calls=0;childProcess.spawn=()=>{calls++;throw Error('must not spawn');};const restore=installNativeMaterialPipe('target',{...material,certificateDER:'x'.repeat(32769)});
 try{assert.throws(()=>childProcess.spawn('target',[],{stdio:'pipe',env:{}}),/exceeds bound/);assert.equal(calls,0);}finally{restore();childProcess.spawn=original;syncBuiltinESMExports();}
});
for(const [name,payload] of [
 ['malformed JSON hides all input fragments','public-sensitive-looking-fragment!'],
 ['reader rejects excess bytes','x'.repeat(32769)],
 ['reader rejects additional keys',JSON.stringify({...material,extra:'public'})],
 ['reader rejects wrong fixture marker',JSON.stringify({...material,fixtureMarker:'public-wrong-marker'})],
 ['reader rejects wrong key size',JSON.stringify({...material,privateKeyX963:Buffer.alloc(96).toString('base64')})]
])test(name,async()=>{
 const code=`import{readMaterialPipe}from ${JSON.stringify(moduleURL)};try{readMaterialPipe();process.exitCode=7;}catch(e){process.stdout.write(e.message);}`;
 const c=childProcess.spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe','pipe'],env:{}}),done=ended(c);c.stdin.end();c.stdio[3].on('error',()=>{});c.stdio[3].end(payload);const result=await done;assert.equal(result.exit,0);assert.equal(result.stdout,'Synthetic identity pipe refused');
});
