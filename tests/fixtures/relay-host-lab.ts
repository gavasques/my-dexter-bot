import { createHash, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, sign, X509Certificate } from 'node:crypto';
import { publicKey, bytes } from '@dexter/relay/protocol';
import { TlsIdentity } from '@dexter/devices';
import type { DevicePin } from '@dexter/relay';
import type { RelayCustodyProvider, DecryptionRequest } from '@dexter/relay-host';
// Test-only actual asymmetric keys, held in memory. No key/auth file is ever written.
const der=(tag:number,...parts:Buffer[])=>{const b=Buffer.concat(parts),n=b.length;const length=n<128?Buffer.from([n]):n<256?Buffer.from([0x81,n]):Buffer.from([0x82,n>>8,n&255]);return Buffer.concat([Buffer.from([tag]),length,b]);};
const seq=(...p:Buffer[])=>der(0x30,...p);const oid=(hex:string)=>der(6,Buffer.from(hex,'hex'));
export function memoryTLS():TlsIdentity {
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),alg=seq(oid('2a8648ce3d040302'));
 const name=seq(der(0x31,seq(oid('550403'),der(0x0c,Buffer.from('relay-lab')))));
 const dt=(d:Date)=>der(0x18,Buffer.from(d.toISOString().replace(/[-:T]/g,'').replace(/\.\d{3}Z$/,'Z')));
 const ext=(o:string,v:Buffer)=>seq(oid(o),der(4,v));
 const extensions=der(0xa3,seq(ext('551d11',seq(der(0x87,Buffer.from([127,0,0,1])),der(0x82,Buffer.from('localhost')))),ext('551d25',seq(oid('2b06010505070301'),oid('2b06010505070302'))),ext('551d13',seq())));
 const tbs=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.from([1])),alg,name,seq(dt(new Date(Date.now()-60000)),dt(new Date(Date.now()+86400000))),name,keys.publicKey.export({type:'spki',format:'der'}),extensions);
 const cert=seq(tbs,alg,der(3,Buffer.from([0]),sign('sha256',tbs,keys.privateKey)));
 const pem='-----BEGIN CERTIFICATE-----\n'+cert.toString('base64').match(/.{1,64}/g)!.join('\n')+'\n-----END CERTIFICATE-----\n';
 return new TlsIdentity(pem,keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),createHash('sha256').update(new X509Certificate(pem).raw).digest('hex'));
}
export function memoryCustody(identity:{installationId:string;ownerId:string;deviceId:string;generation:number;keyId:string}) {
 let signing=generateKeyPairSync('ed25519'),encryption=generateKeyPairSync('x25519');let closes=0;
 const pub=(k:typeof signing.publicKey)=>k.export({type:'spki',format:'der'}).toString('base64');
 const pin:DevicePin=Object.freeze({...identity,signingPublicKey:pub(signing.publicKey),encryptionPublicKey:pub(encryption.publicKey)});
 let holdSign:Promise<void>|null=null,holdDecrypt:Promise<void>|null=null,holdClose:Promise<void>|null=null;let signStarted=false,decryptStarted=false,closeStarted=false,failClose=false;
 const makeProvider=():RelayCustodyProvider=>{let stopped=false;return Object.freeze({kind:'laboratory_memory_only',publicPin:pin,current:()=>!stopped,
  async sign(data:Uint8Array){signStarted=true;if(holdSign)await holdSign;if(stopped)throw Error('lab stopped');return sign(null,Buffer.from(data),signing.privateKey);},
  async decrypt(r:Readonly<DecryptionRequest>){decryptStarted=true;if(holdDecrypt)await holdDecrypt;if(stopped)throw Error('lab stopped');const shared=diffieHellman({privateKey:encryption.privateKey,publicKey:publicKey(r.ephemeralPublicKey,'x25519')}),salt=createHash('sha256').update(`DEXTER_RELAY_KDF_V1\n${r.installationId}`).digest(),key=Buffer.from(hkdfSync('sha256',shared,salt,Buffer.from(`DEXTER_RELAY_AEAD_V1\n${r.aad}`),32));try{const d=createDecipheriv('aes-256-gcm',key,bytes(r.nonce,12,12));d.setAAD(Buffer.from(r.aad));d.setAuthTag(bytes(r.tag,16,16));return Buffer.concat([d.update(bytes(r.ciphertext,32768)),d.final()]);}finally{key.fill(0);shared.fill(0);}},
  async close(){closes++;closeStarted=true;if(holdClose)await holdClose;if(failClose)throw Error('lab close refused');stopped=true;},
 });};
 const provider=makeProvider();
 return {provider,pin,freshProvider:makeProvider,setSignHold:(p:Promise<void>)=>{holdSign=p;},setDecryptHold:(p:Promise<void>)=>{holdDecrypt=p;},setCloseHold:(p:Promise<void>)=>{holdClose=p;},failClose:()=>{failClose=true;},get signStarted(){return signStarted;},get decryptStarted(){return decryptStarted;},get closeStarted(){return closeStarted;},get closes(){return closes;}};
}
export const gate=()=>{let resolve=()=>{};const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
export async function until(fn:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('lab condition deadline');}
