import { DatabaseSync } from 'node:sqlite';
import { HostStore } from '@dexter/hub';
import { RelayStore, type DevicePin } from '@dexter/relay';
import { RelayService, type RelayServiceOptions } from '@dexter/relay-service';
import { memoryTLS } from './relay-host-lab.js';
import { createHash, X509Certificate } from 'node:crypto';
let service:RelayService|undefined,store:RelayStore|undefined,closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{await service?.close();store?.close();process.disconnect();})();
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
process.on('message',async(value:{op:string;dataDir:string;ownerId:string;installationId:string;pins:DevicePin[];capacity:number;associationFile?:string})=>{
 try{if(value.op==='probe'){let writerLocked=false,associationLocked=false;try{const h=new HostStore({dataDir:value.dataDir});h.close();}catch(e){writerLocked=!!e&&typeof e==='object'&&'code'in e&&e.code==='host_locked';}let d:DatabaseSync|undefined;try{d=new DatabaseSync(value.associationFile!);d.exec('PRAGMA busy_timeout=100;');d.prepare('SELECT * FROM metadata').all();}catch{associationLocked=true;}finally{d?.close();}process.send!({writerLocked,associationLocked});await close();return;}if(value.op==='start'){
  store=new RelayStore({dataDir:value.dataDir,ownerId:value.ownerId,installationId:value.installationId,maximumPendingPerRecipient:value.capacity});for(const p of value.pins)store.registerDevice(p);
  const tls=memoryTLS();const options:RelayServiceOptions={store:{borrow:store},tls:{key:tls.keyPem,cert:tls.certPem},host:'127.0.0.1',port:0};service=await RelayService.start(options);const address=service.address;
  process.send!({ready:true,...address,cert:tls.certPem,pin:createHash('sha256').update(new X509Certificate(tls.certPem).raw).digest('base64')});
 }else if(value.op==='close'){await close();}}catch{process.send?.({failed:true});await close();process.exitCode=1;}
});
