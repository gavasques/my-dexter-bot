// TEST ONLY native memory-pipe provider and spawn telemetry around the REAL daemon-main.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {appendFileSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {readMaterialPipe,installNativeMaterialPipe} from './current-native-memory-pipe.mjs';
const env=process.env,root=env.DEXTER_FIXTURE_ROOT,composition=env.DEXTER_FIXTURE_COMPOSITION,native=env.DEXTER_FIXTURE_NATIVE,browser=env.DEXTER_FIXTURE_BROWSER;
assert.ok(root.startsWith('/private/tmp/')&&realpathSync(root)===root&&(lstatSync(root).mode&0o077)===0);
assert.ok(composition.startsWith('/private/tmp/'));
const material=readMaterialPipe();
const log=(file,value)=>appendFileSync(join(root,file),JSON.stringify(value)+'\n',{mode:0o600});
const original=childProcess.spawn;
childProcess.spawn=function(...args){
 const child=original(...args);
 if(args[0]===browser){
  log('chromium-events.jsonl',{event:'spawn',pid:child.pid,argv:args[1],stdio:args[2].stdio,home:args[2].env.HOME});let buffer='';
  child.stdio[4].on('data',chunk=>{buffer+=chunk;while(buffer.includes('\0')){const n=buffer.indexOf('\0'),msg=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(msg.result?.product)log('chromium-events.jsonl',{event:'cdp-version',product:msg.result.product});}});
  child.once('close',(exit,signal)=>log('chromium-events.jsonl',{event:'close',pid:child.pid,exit,signal}));
 }
 return child;
};syncBuiltinESMExports();
installNativeMaterialPipe(native,material,(child,args,options)=>{log('native-events.jsonl',{event:'spawn',pid:child.pid,argv:args,environment:Object.keys(options.env)});child.once('close',(exit,signal)=>log('native-events.jsonl',{event:'close',pid:child.pid,exit,signal}));});
const imp=p=>import(pathToFileURL(join(composition,p)).href);
const {main}=await imp('packages/devices/dist/daemon-main.js');
let dependencies={};
if(env.DEXTER_FIXTURE_GATE==='yes'){
 const {MacDeviceDaemon,createFixtureHandlers,FILE_APPEND}=await imp('packages/devices/dist/index.js');
 dependencies={createDaemon:o=>new MacDeviceDaemon({...o,handlers:createFixtureHandlers({root:root+'/files',enable:[FILE_APPEND],beforeEffect:async()=>{appendFileSync(root+'/effect-entered','entered\n',{mode:0o600});while(!existsSync(root+'/effect-release'))await new Promise(r=>setTimeout(r,10));}})})};
}
process.exitCode=await main(process.argv.slice(2),dependencies);
