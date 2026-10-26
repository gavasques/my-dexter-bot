import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { TextDecoder } from "node:util";
import type { NativeIdentityMode } from "./native-client.js";
import { DeviceError } from "./errors.js";
import { readBinding, type HostTrust } from "./daemon.js";
import { certificateFingerprint, exact, FINGERPRINT, wireId } from "./wire.js";
import { checkCapabilities, FILE_APPEND, FILE_READ, PROCESS_PROBE, BROWSER_NAVIGATE, BROWSER_READ, BROWSER_CLOSE, CUA_OBSERVE, CUA_CONTROL, CUA_STATUS } from "./operations.js";
import { LocalCapabilityPolicy, parseLocalCapabilityConfig } from "./capabilities/policy.js";
import { SelectedFilesPolicy } from "./capabilities/files/policy.js";

const CONFIG_BYTES = 16 * 1024, POLICY_BYTES = 1024 * 1024, CERT_BYTES = 16 * 1024, NATIVE_CONFIG_BYTES = 32 * 1024, NATIVE_EXECUTABLE_BYTES = 64 * 1024 * 1024;
/** Public fingerprint of the native identity this data directory paired with. Never a key. */
export const NATIVE_DEVICE_FILE = "native-device.json";
const CORE = ["dataDir","name","capabilities","hostUrl","hostCertPath","hostFingerprint"];
const BROWSER = [BROWSER_NAVIGATE,BROWSER_READ,BROWSER_CLOSE], CUA = [CUA_OBSERVE,CUA_CONTROL,CUA_STATUS], LAB = [FILE_READ,FILE_APPEND,PROCESS_PROBE];
/** Exactly one trusted transport: the laboratory PEM seam or the native helper. Never both and no fallback. */
export type DaemonClientSelection =
  | { kind:"laboratory-pem";identityDir:string }
  | { kind:"native-helper";executable:string;configPath:string;installationID:string;digest:string;identityMode?:NativeIdentityMode };
interface BaseConfig { dataDir:string;name:string;capabilities:string[];trust:HostTrust;client:DaemonClientSelection }
export interface LabDaemonConfig extends BaseConfig { mode:"laboratory";fixtureRoot:string }
export interface LocalDaemonConfig extends BaseConfig {
  mode:"local-capabilities"|"laboratory-browser";policy:LocalCapabilityPolicy;policyPath:string;
  browser:null|{executable:string;networkIsolation:"none"|"loopback_only"};
  cua:null|{mode:"fixture"|"native";executable:string};
  files?:{policyPath:string;policy:SelectedFilesPolicy};
}
export type DaemonConfig = LabDaemonConfig|LocalDaemonConfig;
function refuse(code:"invalid_input"|"forbidden"|"unavailable"|"unsupported"|"conflict" = "invalid_input"):never {throw new DeviceError(code,"daemon configuration refused");}
function path(value:unknown):string {
  if(typeof value!=="string"||value.length>2048||!isAbsolute(value)||normalize(value)!==value||/[\u0000-\u001f\u007f]/u.test(value))refuse();
  let at=value as string;
  while(at!==parse(at).root){const parent=dirname(at);if(parent===at)break;const s=stat(parent);if(!s?.isDirectory()){
    if(!s?.isSymbolicLink()||!(["/tmp","/var","/etc"].includes(parent)&&realpathSync(parent)==="/private"+parent))refuse("forbidden");
  }at=parent;}
  return value as string;
}
function stat(value:string):Stats|null {try{return lstatSync(value);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;refuse("unavailable");}}
function directory(value:unknown,missing=false):string {const p=path(value),s=stat(p);if(!s&&missing){directory(dirname(p));return p;}if(!s||s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)refuse("forbidden");return p;}
function privateStat(p:string,limit:number):Stats {directory(dirname(p));const s=stat(p);if(!s||s.isSymbolicLink()||!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)refuse("forbidden");if(s.size<1||s.size>limit)refuse();return s!;}
function readPrivate(value:unknown,limit:number):string {
  const p=path(value),before=privateStat(p,limit);let fd:number|undefined;
  try{fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)refuse("forbidden");
    const buffer=Buffer.alloc(opened.size+1);let n=0;while(n<buffer.length){const got=readSync(fd,buffer,n,buffer.length-n,null);if(!got)break;n+=got;}const after=fstatSync(fd),named=stat(p);if(n!==before.size||after.size!==before.size||!named||named.ino!==before.ino||named.dev!==before.dev)refuse("forbidden");return new TextDecoder("utf-8",{fatal:true}).decode(buffer.subarray(0,n));
  }catch(e){if(e instanceof DeviceError)throw e;return refuse("invalid_input");}finally{if(fd!==undefined)closeSync(fd);}
}
function executable(value:unknown):string {const p=path(value),s=stat(p);if(!s||s.isSymbolicLink()||!s.isFile()||(s.mode&0o111)===0||(s.mode&0o022)!==0||(s.uid!==process.getuid?.()&&s.uid!==0))refuse("forbidden");return p;}
function guardStorage(dataDir:string,local:boolean):void {
  if(!stat(dataDir))return;
  for(const file of ["binding.json",NATIVE_DEVICE_FILE]){const p=join(dataDir,file);if(stat(p))privateStat(p,CERT_BYTES);}
  for(const suffix of ["","-wal","-shm","-journal"]){const s=stat(join(dataDir,"journal.sqlite"+suffix));if(s&&(s.isSymbolicLink()||!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0))refuse("forbidden");}
  if(local)for(const suffix of ["capabilities","capabilities/browser","capabilities/browser/profiles","capabilities/browser/home","capabilities/browser/locks","capabilities/browser/state"]){const p=join(dataDir,suffix);if(stat(p))directory(p);}
}
function canonical(value:unknown):string {const p=path(value);let real:string|undefined;try{real=realpathSync(p);}catch{refuse("forbidden");}if(real!==p)refuse("forbidden");return p;}
/** Same owner/mode bounds the native client applies at construction and before every invocation. */
function nativeExecutable(value:unknown):string {const p=canonical(value);directory(dirname(p));const s=stat(p);if(!s||s.isSymbolicLink()||!s.isFile()||(s.mode&0o100)===0||(s.mode&0o077)!==0||s.uid!==process.getuid?.()||s.size<1||s.size>NATIVE_EXECUTABLE_BYTES)refuse("forbidden");return p;}
function strictBase64(value:unknown):Buffer {if(typeof value!=="string"||value.length>21848||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))refuse();const b=Buffer.from(value,"base64");if(b.toString("base64")!==value)refuse();return b;}
/**
 * Reads the private native helper configuration and binds it to the outer operator trust: same
 * installation, exact same host URL string, same public host certificate DER and pin. Only public data is
 * read; no identity is loaded and no helper is invoked. The digest lets the caller confirm the file the
 * client froze at construction is the one validated here.
 */
function nativeBinding(selection:{executable:string;configPath:string;installationID:string;identityMode?:NativeIdentityMode},trust:HostTrust,productionOnly=false):string {
  const text=readPrivate(canonical(selection.configPath),NATIVE_CONFIG_BYTES);let raw:unknown;try{raw=configJson(text);}catch{refuse();}noControls(raw);
  const c=exact(raw,["installationID","hostURL","hostCertificateDER","hostFingerprint"],["laboratoryID"]);
  if(productionOnly&&c.laboratoryID!==undefined)refuse("forbidden");
  if(c.installationID!==selection.installationID||(c.laboratoryID!==undefined&&(typeof c.laboratoryID!=="string"||!/^[0-9a-f]{32}$/.test(c.laboratoryID))))refuse("forbidden");
  if(typeof c.hostURL!=="string"||c.hostURL!==trust.hostUrl)refuse("forbidden");
  if(selection.identityMode==="laboratory-native"&&(c.laboratoryID===undefined||!/^https:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(c.hostURL)))refuse("forbidden");
  const der=strictBase64(c.hostCertificateDER);
  if(c.hostFingerprint!==trust.hostFingerprint||!der.equals(new X509Certificate(trust.hostCertPem).raw))throw new DeviceError("tls_pin_mismatch","native helper pin refused");
  return createHash("sha256").update(text).digest("hex");
}
function nativeSelection(value:unknown,trust:HostTrust,dataDir:string):DaemonClientSelection {
  const c=exact(value,["kind","executable","configPath","installationID"],["identityMode"]);
  if(c.identityMode!==undefined&&c.identityMode!=="production"&&c.identityMode!=="laboratory-native")refuse();
  const identityMode=c.identityMode as NativeIdentityMode|undefined;let installationID:string;try{installationID=wireId(c.installationID);}catch{refuse();}
  const executable=nativeExecutable(c.executable),configPath=canonical(c.configPath),digest=nativeBinding({executable,configPath,installationID,...(identityMode?{identityMode}:{})},trust);
  // An existing binding must belong to the same host pin and installation before any helper runs.
  if(stat(join(dataDir,"binding.json"))){const b=readBinding(dataDir);if(b&&b.hostFingerprint!==trust.hostFingerprint)throw new DeviceError("tls_pin_mismatch","binding belongs to another host pin");if(b&&b.installationId!==installationID)refuse("conflict");}
  return {kind:"native-helper",executable,configPath,installationID,digest,...(identityMode?{identityMode}:{})};
}
/** Re-reads after the native client froze its configuration: any change or cross-binding drift refuses. */
export function confirmNativeSelection(selection:DaemonClientSelection,trust:HostTrust):void {
  if(selection.kind!=="native-helper")refuse();
  try{nativeExecutable(selection.executable);if(nativeBinding(selection,trust)!==selection.digest)refuse("forbidden");}
  catch(e){if(e instanceof DeviceError&&e.code==="tls_pin_mismatch")throw e;refuse("forbidden");}
}
/**
 * Binds the data directory to the public fingerprint returned by the native helper's load. The first
 * load is recorded before pairing; afterwards any other identity is a conflict before any request. A
 * binding without a recorded native fingerprint is never adopted (no PEM-to-native fallback).
 */
export function bindNativeDevice(dataDir:string,fingerprint:string):void {
  try{
    if(typeof fingerprint!=="string"||!FINGERPRINT.test(fingerprint))refuse("forbidden");
    const file=join(dataDir,NATIVE_DEVICE_FILE);
    if(stat(file)){const v=exact(JSON.parse(readPrivate(file,CERT_BYTES)),["fingerprint"]);if(v.fingerprint!==fingerprint)refuse("conflict");return;}
    if(stat(join(dataDir,"binding.json")))refuse("conflict");
    if(!stat(dataDir)){directory(dirname(dataDir));mkdirSync(dataDir,{mode:0o700});}directory(dataDir);
    const temp=`${file}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify({fingerprint}),{flag:"wx",mode:0o600});renameSync(temp,file);privateStat(file,CERT_BYTES);
  }catch(e){if(e instanceof DeviceError)throw e;refuse("unavailable");}
}
function pemSelection(identityDir:unknown):DaemonClientSelection {const dir=directory(identityDir);privateStat(join(dir,"key.pem"),CERT_BYTES);privateStat(join(dir,"cert.pem"),CERT_BYTES);return{kind:"laboratory-pem",identityDir:dir};}
/** JSON.parse alone silently accepts duplicate keys, including escaped aliases. Reject ambiguous operator input. */
function configJson(text:string):unknown {
  const value:unknown=JSON.parse(text);
  const stack:({keys:Set<string>;key:boolean}|null)[]=[];
  for(const token of text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu)??[]){
    const top=stack.at(-1);
    if(token==="{")stack.push({keys:new Set(),key:true});
    else if(token==="[")stack.push(null);
    else if(token==="}"||token==="]")stack.pop();
    else if(token===":"&&top)top.key=false;
    else if(token===","&&top)top.key=true;
    else if(top?.key&&token.startsWith('"')){const key=JSON.parse(token) as string;if(top.keys.has(key))refuse();top.keys.add(key);}
  }
  return value;
}
function noControls(value:unknown):void {if(typeof value==="string"&&/[\u0000-\u001f\u007f]/u.test(value))refuse();if(Array.isArray(value))for(const x of value)noControls(x);else if(value&&typeof value==="object")for(const x of Object.values(value))noControls(x);}
export function parseDaemonArguments(argv:readonly string[]):{configPath:string;pair:boolean} {
  if(argv.length<2||argv.length>3||argv[0]!=="--config"||typeof argv[1]!=="string"||(argv.length===3&&argv[2]!=="--pair"))refuse();return{configPath:path(argv[1]),pair:argv.length===3};
}
/** Validates bounded trusted operator configuration before identity loading, journal creation or launch. */
export function readDaemonConfig(configPath:string):DaemonConfig {
  try{
    const raw:unknown=configJson(readPrivate(configPath,CONFIG_BYTES));noControls(raw);const object=(raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:{}) as Record<string,unknown>;
    // Discriminators: no mode = legacy laboratory (v0); local-capabilities v1 = PEM; explicit v2 = tagged client.
    const mode=object.mode===undefined?"legacy":object.mode,labBrowser=mode==="laboratory-browser",local=mode==="local-capabilities"||labBrowser;
    if(mode!=="legacy"&&mode!=="laboratory"&&!local)refuse();
    const v2=mode!=="legacy"&&object.version===2;if((mode==="laboratory"||labBrowser)&&!v2)refuse();if(local&&object.version!==1&&!v2)refuse();
    const v=exact(raw,v2?[...CORE,"mode","version","client",...(local?["policyPath","browser","cua"]:["fixtureRoot"])]:local?[...CORE,"identityDir","mode","version","policyPath","browser","cua"]:[...CORE,"identityDir","fixtureRoot"],v2&&mode==="local-capabilities"?["files"]:[]);
    if(typeof v.name!=="string"||!/^([\p{L}\p{N} ._-]){1,48}$/u.test(v.name))refuse();
    const dataDir=directory(v.dataDir,true);let client:DaemonClientSelection|null=null;
    if(!v2)client=pemSelection(v.identityDir);else{const kind=exact(v.client,["kind"],["identityDir","executable","configPath","installationID","identityMode"]).kind;
      if(kind==="laboratory-pem")client=pemSelection(exact(v.client,["kind","identityDir"]).identityDir);else if(kind!=="native-helper")refuse();}
    guardStorage(dataDir,local);
    const capabilities=checkCapabilities(v.capabilities as string[]);if(!Array.isArray(v.capabilities)||capabilities.length!==v.capabilities.length)refuse();
    if(typeof v.hostUrl!=="string"||v.hostUrl.length>2048||typeof v.hostFingerprint!=="string"||!FINGERPRINT.test(v.hostFingerprint))refuse();const url=new URL(v.hostUrl as string);
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/"||!url.hostname)refuse();
    const hostCertPem=readPrivate(v.hostCertPath,CERT_BYTES);if(certificateFingerprint(hostCertPem)!==v.hostFingerprint)throw new DeviceError("tls_pin_mismatch","daemon host pin refused");
    const trust={hostUrl:v.hostUrl as string,hostCertPem,hostFingerprint:v.hostFingerprint as string};
    const base={dataDir,name:v.name as string,capabilities,trust,client:client??nativeSelection(v.client,trust,dataDir)};
    // Dedicated trusted laboratory mode: explicit memory identity and owned loopback browser only.
    // Laboratory browser stays disjoint from CUA; native CUA selection below requires explicit production identity.
    if(labBrowser){
      if(base.client.kind!=="native-helper"||base.client.identityMode!=="laboratory-native"||v.cua!==null||capabilities.length===0||capabilities.some(c=>!BROWSER.includes(c)))refuse("forbidden");
    }else if(local&&base.client.kind==="native-helper"&&base.client.identityMode==="laboratory-native")refuse("forbidden");
    if(!local){if(capabilities.some(c=>!LAB.includes(c)))refuse("unsupported");return{...base,mode:"laboratory",fixtureRoot:directory(v.fixtureRoot)};}
    let browser:LocalDaemonConfig["browser"]=null,cua:LocalDaemonConfig["cua"]=null;
    if(v.browser!==null){const b=exact(v.browser,["executable","networkIsolation"]);if(b.networkIsolation!=="none"&&b.networkIsolation!=="loopback_only")refuse();browser={executable:executable(b.executable),networkIsolation:b.networkIsolation};}
    if(labBrowser&&(!browser||browser.networkIsolation!=="loopback_only"))refuse("forbidden");
    if(v.cua!==null){const c=exact(v.cua,["mode","executable"]);
      if(c.mode==="native"){
        // Explicit operator routing only. No implicit identity mode, laboratory binding or fixture fallback.
        if(!v2||mode!=="local-capabilities"||base.client.kind!=="native-helper"||base.client.identityMode!=="production")refuse("unsupported");
        if(nativeBinding(base.client,trust,true)!==base.client.digest)refuse("forbidden");
        cua={mode:"native",executable:nativeExecutable(c.executable)};
      }else{if(c.mode!=="fixture")refuse();cua={mode:"fixture",executable:executable(c.executable)};}
    }
    let files:LocalDaemonConfig["files"];
    if(v.files!==undefined&&v.files!==null){
      if(!v2||mode!=="local-capabilities"||base.client.kind!=="native-helper"||base.client.identityMode!=="production")refuse("unsupported");
      const f=exact(v.files,["policyPath"]),filePolicyPath=canonical(f.policyPath);
      files={policyPath:filePolicyPath,policy:SelectedFilesPolicy.load(filePolicyPath,base.client.installationID)};
    }
    const enabled=[...(browser?BROWSER:[]),...(cua?CUA:[]),...(files?[FILE_READ,FILE_APPEND]:[])];if(capabilities.some(c=>!enabled.includes(c)))refuse("unsupported");
    const policyPath=path(v.policyPath);directory(dirname(policyPath));let policyValue:unknown={version:1,bots:[]};if(stat(policyPath)){policyValue=configJson(readPrivate(policyPath,POLICY_BYTES));noControls(policyValue);}
    const policy=new LocalCapabilityPolicy(parseLocalCapabilityConfig(policyValue),policyPath);return{...base,mode:labBrowser?"laboratory-browser":"local-capabilities",policyPath,policy,browser,cua,...(files?{files}:{})};
  }catch(e){if(e instanceof DeviceError)throw e;refuse();}
}
