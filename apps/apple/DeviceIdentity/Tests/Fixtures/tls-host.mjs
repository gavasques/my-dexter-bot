import { createAppleFixtureTLS } from "../../../Tests/Fixtures/memory-tls.mjs";
// Synthetic loopback TLS host only. Receives a public client pin, never a client private key.
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';

const [root,expectedPin,mode="normal"] = process.argv.slice(2);
const material=await createAppleFixtureTLS({mode,wrongSan:"wrong.example"});
const {cert,key,x509}=material;
fs.writeFileSync(root+'/host.crt',cert,{mode:0o600,flag:'wx'});
fs.writeFileSync(root+'/requests.txt','0',{mode:0o600});
let requests=0;
const server=https.createServer({key,cert,minVersion:mode==='tls12'?'TLSv1.2':'TLSv1.3',maxVersion:mode==='tls12'?'TLSv1.2':'TLSv1.3',requestCert:true,rejectUnauthorized:false},(req,res)=>{
 requests++;fs.writeFileSync(root+'/requests.txt',String(requests),{mode:0o600});
 const peer=req.socket.getPeerCertificate();const fp=peer.raw?crypto.createHash('sha256').update(peer.raw).digest('hex'):'';
 if(fp!==expectedPin||req.socket.isSessionReused()){res.destroy();return;}
 const client=new crypto.X509Certificate(peer.raw);
 if(!client.verify(client.publicKey)||client.ca||!client.keyUsage?.includes('1.3.6.1.5.5.7.3.2')){res.destroy();return;}
 let bytes=Buffer.alloc(0);req.on('data',c=>{bytes=Buffer.concat([bytes,c]);if(bytes.length>65536)req.destroy();});
 req.on('end',()=>{
  let body;try{body=JSON.parse(bytes)}catch{res.destroy();return;}
  if(req.method!=='POST'||!['/v1/pair/claim','/v1/pair/status','/v1/device/poll','/v1/device/receipt'].includes(req.url)){res.destroy();return;}
  res.setHeader('content-type','application/json');
  const send=body=>{res.setHeader('content-length',Buffer.byteLength(body));res.end(body)};
  if(body.fixture==='barelf'){req.socket.end('HTTP/1.1 200 OK\r\nX-A: b\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n{}');return;}
  if(body.fixture==='error'){res.statusCode=403;send(JSON.stringify({error:'forbidden',message:'synthetic-peer-message'}));return;}
  if(body.fixture==='redirect'){res.statusCode=302;res.setHeader('location','https://127.0.0.1:'+server.address().port+'/forbidden');send('{}');return;}
  if(body.fixture==='large'){send(JSON.stringify({body:'x'.repeat(262144)}));return;}
  if(body.fixture==='badjson'){send('[]');return;}
  if(body.fixture==='delay'){setTimeout(()=>send('{}'),1000);return;}
  send(JSON.stringify({ok:true,tls:req.socket.getProtocol(),pinMatched:fp===expectedPin,resumed:req.socket.isSessionReused(),requests}));
 });
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port,certificateDER:x509.raw.toString('base64'),fingerprint:crypto.createHash('sha256').update(x509.raw).digest('hex')})+'\n'));
setTimeout(()=>{server.close();process.exit(0)},20000).unref();
