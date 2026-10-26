import { createAppleFixtureTLS } from "./memory-tls.mjs";
// Synthetic loopback laboratory. Imports the CURRENT pinned private production composition.
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
let httpRequests=0;
const originalCreateServer=https.createServer;
https.createServer=function(...args){const server=originalCreateServer.apply(this,args);server.on('request',()=>{httpRequests++;});return server;};
syncBuiltinESMExports();
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const [root, composition] = process.argv.slice(2);
if (!root?.startsWith('/private/tmp/') || !composition?.startsWith('/private/tmp/')) throw new Error('private fixture path required');
const { HostServices } = await import(pathToFileURL(join(composition,'packages/cli/dist/host-services.js')).href);
const { HostStore } = await import(pathToFileURL(join(composition,'packages/hub/dist/index.js')).href);
const identityDir=join(root,'host-id');mkdirSync(identityDir,{mode:0o700});
const material=await createAppleFixtureTLS({name:'dexter-synthetic-actual-host',composition});
writeFileSync(join(identityDir,'cert.pem'),material.identity.certPem,{mode:0o600,flag:'wx'});
const identity=material.identity;let calls=0;
const driver=engine=>({id:engine,capabilities:{resume:true,interrupt:true,fork:false,steer:false},async status(){return {engine,installed:true,version:'synthetic',authentication:'authenticated',billing:'subscription'};},async open(threadId,nativeCursor){return {threadId,nativeCursor:nativeCursor??'synthetic-cursor'};},async *turn(session,turnId){calls++;yield {type:'text.delta',threadId:session.threadId,turnId,text:'Synthetic reply'};yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async respondToTool(){},async interrupt(){},async close(){}});
const options={dataDir:join(root,'store'),enableEngines:true,makeDriver:driver,appClients:{identity,listenHost:'127.0.0.1',port:0}};
let services=new HostServices(options),url=await services.startAppClients();options.appClients.port=Number(new URL(url).port);
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const offer=()=>services.appClientsAdmin.pairingBundle({kind:'pair',role:'client-mac',scopes:['approvals.decide','approvals.read','chat.read','chat.write','devices.manage','devices.read']});
send({bundle:offer()});
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
let exiting=false;
async function cleanup(){if(exiting)return;exiting=true;await services.shutdown({graceMs:3000});input.close();}
process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(0));});
for await(const line of input){
 try {
  const command=JSON.parse(line);
  if(command.op==='approve'){send({deviceId:services.appClientsAdmin.approveClaim(command.claimID).deviceId});}
  else if(command.op==='restart'){await services.shutdown({graceMs:3000});services=new HostServices(options);url=await services.startAppClients();send({url});}
  else if(command.op==='advance'){services.store.now=()=>Date.now()+3_600_000;send({advanced:true});}
  else if(command.op==='action'){services.store.setGrant({botId:command.botID,tool:'synthetic.notice',destination:'conn-A',policy:'ask'});const action=services.store.requestAction({botId:command.botID,threadId:command.threadID,tool:'synthetic.notice',destination:'conn-A',arguments:{fixture:true,accountId:'personal',payload:{text:'  ação "quoted"\n ',items:[1,false,null,{destination:'nested-only'}]}},idempotencyKey:command.key??'synthetic_action' });send({actionID:action.id});}
  else if(command.op==='wait'){await services.runtime.waitForTurn(command.turnID);send({completed:true});}
  else if(command.op==='offer'){send({bundle:offer()});}
  else if(command.op==='revoke'){services.peersHttp.revoke(command.deviceID);send({revoked:true});}
  else if(command.op==='inspect'){
   let held=false;try{const second=new HostStore({dataDir:options.dataDir});second.close();}catch(error){held=error.code==='host_locked';}
   send({hostID:services.store.hostId,bots:services.store.listBots().length,devices:services.store.listDevices().length,pendingClaims:services.appClientsAdmin.pendingClaims().map(x=>({claimID:x.claimId,clientFingerprint:x.clientFingerprint})),calls,httpRequests,writerHeld:held});
  } else if(command.op==='stop'){await cleanup();const reopened=new HostStore({dataDir:options.dataDir});const devices=reopened.listDevices().length;reopened.close();send({stopped:true,writerReleased:true,devices});break;}
  else throw new Error('closed fixture command');
 }catch{send({fixtureError:true});}
}
await cleanup();
