import { createAppleFixtureTLS } from "./memory-tls.mjs";
// Owned synthetic loopback server. Client key stays only in Swift memory.
import https from 'node:https';import tls from 'node:tls';import fs from 'node:fs';import crypto from 'node:crypto';
const [root,pin,mode='normal']=process.argv.slice(2);const material=await createAppleFixtureTLS({mode,wrongSan:"wrong.invalid"});
const {cert,key,x509}=material;
fs.writeFileSync(root+'/host.crt',cert,{mode:0o600,flag:'wx'});
let requests=0,missingRejected=0;
function saveRequests(){fs.writeFileSync(root+'/requests.pending',String(requests),{mode:0o600});fs.renameSync(root+'/requests.pending',root+'/requests.txt');}
saveRequests();
const server=https.createServer({key,cert,minVersion:mode==='tls12'?'TLSv1.2':'TLSv1.3',maxVersion:mode==='tls12'?'TLSv1.2':'TLSv1.3',requestCert:true,rejectUnauthorized:false},(req,res)=>{
 const peer=req.socket.getPeerCertificate(); const actual=peer?.raw?crypto.createHash('sha256').update(peer.raw).digest('hex'):''; if(actual!==pin){res.destroy();return}
 requests++;saveRequests();
 let bytes=Buffer.alloc(0);req.on('data',c=>{bytes=Buffer.concat([bytes,c]);if(bytes.length>65536)req.destroy()});
 req.on('end',()=>{
  let body={};try{if(bytes.length)body=JSON.parse(bytes)}catch{res.destroy();return}
  const send=(value,status=200)=>{const text=JSON.stringify(value);res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('content-length',Buffer.byteLength(text));res.setHeader('connection','close');res.end(text)};
  if(mode==='redirect'){res.setHeader('location','https://127.0.0.1:'+server.address().port+'/evil');send({},302);return}
  if(mode==='large'){send({body:'x'.repeat(262144)});return}
  if(mode==='barelf'){req.socket.end('HTTP/1.1 200 OK\r\nX-A: b\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');return}
  if(mode==='delay'){setTimeout(()=>send({late:true}),1000);return}
  if(req.url==='/app-client/v1/pair/claim'){
   if(req.method!=='POST'||Object.keys(body).sort().join(',')!=='code,name,offerId'){send({error:'invalid_input'},400);return}
   send({claimId:'claim_fixture',status:'pending'});return;
  }
  if(req.url==='/app-client/v1/pair/status'){
   if(req.method!=='POST'||Object.keys(body).join(',')!=='claimId'){send({error:'invalid_input'},400);return}
   const role=mode==='client-mac'||mode.startsWith('paired-mock')?'client-mac':'client-ios';const scopes=['chat.read','chat.write','approvals.read','approvals.decide','devices.read','devices.manage','grants.read','grants.manage'];
   send({protocol:'dexter-app-client-v1',status:'approved',deviceId:'device_fixture',installationId:mode==='foreign-install'?'foreign_host':'host_fixture',ownerId:'owner_fixture',role,scopes,pinGeneration:1,bindingRevision:1});return;
  }
  if(mode.startsWith('paired-mock')&&req.url==='/health'){send({protocolVersion:1,mode:'paired-client',remotePairing:'implemented',installationId:'host_fixture',engineRouting:'fixture',client:{deviceId:'device_fixture',role:'client-mac',scopes:['approvals.decide','approvals.read','chat.read','chat.write','devices.manage','devices.read','grants.manage','grants.read'],pinGeneration:1,bindingRevision:1}});return}
  if(mode==='paired-mock-503'&&req.url==='/v1/devices/device_fixture/revoke'){send({error:'not_ready',effect:'none'},503);return}
  if(mode==='paired-mock-500'&&req.url==='/v1/devices/device_fixture/revoke'){send({error:'host_failure',effect:'unknown'},500);return}
  if(mode.startsWith('paired-mock')&&req.url==='/v1/devices/device_fixture/revoke'){send({deviceId:'device_fixture',status:'revoked'});return}
  send({ok:true,method:req.method,path:req.url,tls:req.socket.getProtocol(),resumed:req.socket.isSessionReused(),requests},req.method==='POST'?201:200);
 });
});
server.on('secureConnection',socket=>{
 const peer=socket.getPeerCertificate();const fingerprint=peer?.raw?crypto.createHash('sha256').update(peer.raw).digest('hex'):'';
 if(!peer?.raw){missingRejected++;socket.destroy();return}
 const client=new crypto.X509Certificate(peer.raw);
 if(fingerprint!==pin||socket.isSessionReused()||!client.verify(client.publicKey)||client.ca||!client.keyUsage?.includes('1.3.6.1.5.5.7.3.2'))socket.destroy();
});
server.listen(0,'127.0.0.1',()=>{
 const port=server.address().port;
 // A real TLS client with no certificate must never reach HTTP. No global trust/config changes.
 const empty=tls.connect({host:'127.0.0.1',port,rejectUnauthorized:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},()=>empty.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nConnection: close\r\n\r\n'));
 let emitted=false;const emit=()=>{if(emitted)return;emitted=true;process.stdout.write(JSON.stringify({port,certificateDER:x509.raw.toString('base64'),fingerprint:crypto.createHash('sha256').update(x509.raw).digest('hex'),missingRejected,requests})+'\n')};empty.on('error',()=>{});empty.on('close',emit);setTimeout(()=>{empty.destroy();emit()},1000).unref();
});setTimeout(()=>{server.close();process.exit(0)},30000).unref();
