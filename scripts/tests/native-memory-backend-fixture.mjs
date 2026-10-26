// Synthetic contract fixture: real Node HTTP listener + OWN inherited stdin FIFO; no Keychain/OpenViking account.
import http from 'node:http';
import { readFileSync, existsSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const args=process.argv.slice(2), arg=name=>args[args.indexOf(name)+1];
const dataDir=arg('--data-dir'), port=Number(arg('--port'));
const mode=()=>existsSync(join(dataDir,'qa-mode.json')) ? JSON.parse(readFileSync(join(dataDir,'qa-mode.json'),'utf8')) : {};
const hostId='host_memory_qa', ownerId='owner_memory_qa';
let settings={revision:0,origin:null,enabled:false,updatedAt:null}, boundOrigin=null, ready=false, privateRequest=null, generation=0;
const stdinStat=fstatSync(0);
const receipts=new Map(), counters={patches:0,privateFrames:0,browserFrames:0,startupUnlockFrames:0,privateOperations:[],
  stdin:{uid:stdinStat.uid,nlink:stdinStat.nlink,mode:stdinStat.mode,isFIFO:stdinStat.isFIFO(),isSocket:stdinStat.isSocket(),processUid:process.getuid(),platform:process.platform}};
const canonical=value=>value && typeof value==='object' && !Array.isArray(value)
  ? '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}' : JSON.stringify(value);
const status=()=>({backend:'openviking',settings,scope:'host_owned_account_per_bot_users',
  administrativeOperations:'owner_local_only',semanticRecall:'unproven',externalServiceOwned:false,generation,privateRequest,
  state:!settings.enabled?'disabled':boundOrigin && boundOrigin!==settings.origin?'restart_required':ready?'configured_unverified':'private_unlock_required'});
const reply=(res,code,value)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname, qa=mode();
  if(path==='/health')return reply(res,200,{protocolVersion:1,mode:'local-development',engineRouting:'disabled',remotePairing:'not_implemented',
    hostId:qa.wrongHost?'different_host':hostId,state:{hostId,ownerId:qa.wrongOwner?'different_owner':ownerId}});
  if(path==='/qa/counters')return reply(res,200,counters);
  if(path==='/v1/memory-backend/status'){
    const value=status(); if(qa.statusWrongRequest && value.privateRequest)value.privateRequest={...value.privateRequest,requestId:'00000000-0000-0000-0000-000000000099'};
    return setTimeout(()=>reply(res,200,value),qa.delayStatus??0);
  }
  if(path.startsWith('/v1/memory-backend/receipts/')) {
    let receipt=receipts.get(decodeURIComponent(path.split('/').at(-1)))??null;
    if(receipt && qa.corruptReceipt)receipt={...receipt,requestHash:'b'.repeat(64)};
    return reply(res,200,{receipt});
  }
  if(req.method==='PATCH' && path==='/v1/memory-backend/settings'){
    ++counters.patches; let bytes='';for await(const part of req)bytes+=part;
    let input;try{input=JSON.parse(bytes);}catch{return reply(res,400,{error:'invalid_input'});}
    if(Object.keys(input).sort().join(',')!=='clientRequestId,enabled,expectedHostId,expectedRevision,origin')return reply(res,400,{error:'invalid_input'});
    if(input.expectedHostId!==hostId)return reply(res,403,{error:'forbidden'});
    const normalized={...input,origin:input.origin.replace(/\/$/,'')},hash=createHash('sha256').update(canonical(normalized)).digest('hex');
    let receipt=receipts.get(input.clientRequestId);
    if(receipt && receipt.requestHash!==hash)return reply(res,409,{error:'conflict'});
    if(!receipt){
      if(input.expectedRevision!==settings.revision)return reply(res,409,{error:'conflict'});
      const previousRevision=settings.revision,committedAt=1000+previousRevision;
      settings={revision:previousRevision+1,origin:normalized.origin,enabled:input.enabled,updatedAt:committedAt};
      receipt={hostId,ownerId,clientRequestId:input.clientRequestId,requestHash:hash,previousRevision,settings,committedAt};receipts.set(input.clientRequestId,receipt);
      ++generation;if(!settings.enabled || boundOrigin && boundOrigin!==settings.origin)ready=false;
    }
    if(qa.loseSettingsACK){req.socket.destroy();return;}
    return reply(res,200,{receipt:qa.corruptReceipt?{...receipt,requestHash:'b'.repeat(64)}:receipt,status:status()});
  }
  reply(res,404,{error:'not_found'});
});
const lineReader=createInterface({input:process.stdin,crlfDelay:Infinity});
lineReader.on('line',line=>{
  let f;try{f=JSON.parse(line);}catch{return;}
  if(f.schema==='dexter.private-input/1'){++counters.startupUnlockFrames;return;}
  if(f.schema==='dexter.browser-use-key/1'){
    ++counters.browserFrames;process.stdout.write(JSON.stringify({schema:'dexter.browser-use-key-ack/1',requestId:f.requestId,hostID:f.hostID,status:f.operation==='lock'?'locked':'ready'})+'\n');return;
  }
  if(f.schema!=='dexter.memory-backend-key/1')return;
  ++counters.privateFrames;counters.privateOperations.push(f.operation);
  const common=['schema','requestId','hostID','origin','expectedRevision','operation'];
  const fields=f.operation==='create'?[...common,'wrappingKeyBase64','administrativeKey','administrativeRole']:f.operation==='unlock'?[...common,'wrappingKeyBase64','administrativeRole']:common;
  const wrap=f.operation==='lock'?null:Buffer.from(f.wrappingKeyBase64??'','base64');
  const valid=Object.keys(f).sort().join(',')===fields.sort().join(',') && f.hostID===hostId && f.expectedRevision===settings.revision && f.origin===settings.origin
    && /^[0-9a-f-]{36}$/.test(f.requestId) && (f.operation==='lock' || settings.enabled && (!boundOrigin || boundOrigin===f.origin)
      && !ready && wrap.length===32 && wrap.toString('base64')===f.wrappingKeyBase64 && ['root','workspace_admin'].includes(f.administrativeRole)
      && (f.operation!=='create' || typeof f.administrativeKey==='string' && Buffer.byteLength(f.administrativeKey)>0 && Buffer.byteLength(f.administrativeKey)<=4096));
  const result=valid?(f.operation==='lock'?'locked':'ready'):'refused';
  if(valid){ready=result==='ready';if(ready)boundOrigin=f.origin;++generation;privateRequest={requestId:f.requestId,operation:f.operation,revision:f.expectedRevision,state:result};}
  wrap?.fill(0);delete f.administrativeKey;delete f.wrappingKeyBase64;
  const ack={schema:'dexter.memory-backend-key-ack/1',requestId:f.requestId,hostID:hostId,status:result,...result==='refused'?{code:'private_input_refused'}:{}};
  const qa=mode();
  if(qa.wrongPrivateHost){process.stdout.write(JSON.stringify({...ack,hostID:'different_host'})+'\n');return;}
  if(!qa.losePrivateACK)process.stdout.write(JSON.stringify(ack)+'\n');
});
server.listen(port,'127.0.0.1',()=>process.stdout.write(JSON.stringify({status:'ready',mode:'local-development',url:`http://127.0.0.1:${port}`,hostId,
  engineExecution:'disabled',mcpGateway:'disabled',deviceTurnTools:'disabled',deviceChannel:{status:'unconfigured'}})+'\n'));
function stop(){lineReader.close();server.close(()=>process.exit(0));}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
