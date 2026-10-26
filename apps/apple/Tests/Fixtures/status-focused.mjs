import { createAppleFixtureTLS } from "./memory-tls.mjs";
// Owned synthetic loopback host for the SDK LOW R4 status probes (adapted from the Opus R2 OR2-1 fixture). Modes: client-mac, status-pending, status-rejected, foreign-install.
// Client key stays only in Swift memory; the server pins the client certificate and counts only authenticated HTTP requests.
import https from 'node:https';import fs from 'node:fs';import crypto from 'node:crypto';
const [root,pin,mode='client-mac']=process.argv.slice(2);const material=await createAppleFixtureTLS({mode,wrongSan:"wrong.invalid"});
const {cert,key,x509}=material;
fs.writeFileSync(root+'/host.crt',cert,{mode:0o600,flag:'wx'});
let requests=0;
function saveRequests(){fs.writeFileSync(root+'/requests.pending',String(requests),{mode:0o600});fs.renameSync(root+'/requests.pending',root+'/requests.txt');}
saveRequests();
const server=https.createServer({key,cert,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',requestCert:true,rejectUnauthorized:false},(req,res)=>{
 const peer=req.socket.getPeerCertificate();const actual=peer?.raw?crypto.createHash('sha256').update(peer.raw).digest('hex'):'';if(actual!==pin){res.destroy();return}
 requests++;saveRequests();
 let bytes=Buffer.alloc(0);req.on('data',c=>{bytes=Buffer.concat([bytes,c]);if(bytes.length>65536)req.destroy()});
 req.on('end',()=>{
  const send=(value,status=200)=>{const text=JSON.stringify(value);res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('content-length',Buffer.byteLength(text));res.setHeader('connection','close');res.end(text)};
  if(req.url==='/app-client/v1/pair/claim'){send({claimId:'claim_fixture',status:'pending'});return}
  if(req.url==='/app-client/v1/pair/status'){
   if(mode==='status-pending'||mode==='status-rejected'){send({protocol:'dexter-app-client-v1',status:mode==='status-pending'?'pending':'rejected',deviceId:null,installationId:null,ownerId:null,role:'client-mac',scopes:['chat.read'],pinGeneration:null,bindingRevision:null});return}
   send({protocol:'dexter-app-client-v1',status:'approved',deviceId:'device_fixture',installationId:mode==='foreign-install'?'foreign_host':'host_fixture',ownerId:'owner_fixture',role:'client-mac',scopes:['chat.read','chat.write','approvals.read','approvals.decide','devices.read','devices.manage','grants.read','grants.manage'],pinGeneration:1,bindingRevision:1});return;
  }
  send({error:'not_found'},404);
 });
});
server.listen(0,'127.0.0.1',()=>{process.stdout.write(JSON.stringify({port:server.address().port,certificateDER:x509.raw.toString('base64'),fingerprint:crypto.createHash('sha256').update(x509.raw).digest('hex')})+'\n')});
setTimeout(()=>{server.close();process.exit(0)},30000).unref();
