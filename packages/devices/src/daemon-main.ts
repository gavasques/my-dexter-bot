#!/usr/bin/env node
// Trusted operator daemon composition. Private --config only; pairing code is bounded stdin only.
import { realpathSync } from "node:fs";
import { DeviceError } from "./errors.js";
import { loadIdentity } from "./files.js";
import { createFixtureHandlers } from "./handlers.js";
import { MacDeviceDaemon, pairDevice, readBinding, type DaemonOptions, type DeviceClientPort, type TrustedClientSelection } from "./daemon.js";
import { NativeDeviceClient, type NativeDeviceClientOptions, type NativePublicIdentity } from "./native-client.js";
import { exact, wireId } from "./wire.js";
import { readDaemonConfig, parseDaemonArguments, confirmNativeSelection, bindNativeDevice, type LocalDaemonConfig } from "./daemon-config.js";
import { createLocalCapabilities, ChromePipeDriver, CuaHelperProcess, type LocalCapabilities } from "./capabilities/index.js";

const emit = (event:Record<string,unknown>):void=>{process.stdout.write(`${JSON.stringify(event)}\n`);};
type DaemonLifecycle = Pick<MacDeviceDaemon,"binding"|"start"|"stop">;
/** The native transport as used by startup: public load only, then the DeviceClientPort. */
export interface NativeClientHandle extends DeviceClientPort { readonly hostFingerprint:string;loadOnly(timeoutMs?:number,signal?:AbortSignal):Promise<NativePublicIdentity> }
/** Library-test seams from trusted host code only, never JSON/config/engine arguments. */
export interface DaemonMainDependencies {
  signal?:AbortSignal;emit?:(event:Record<string,unknown>)=>void;
  loadIdentity?:typeof loadIdentity;pairDevice?:typeof pairDevice;
  readPairingLine?:(signal:AbortSignal)=>Promise<{offerId:string;code:string}>;
  createCapabilities?:(config:LocalDaemonConfig)=>LocalCapabilities;
  createDaemon?:(options:DaemonOptions)=>DaemonLifecycle;
  createNativeClient?:(options:NativeDeviceClientOptions)=>NativeClientHandle;
}
/** Starts every close synchronously (blocking admissions) and settles all of them; any rejection is kept. */
async function closeAll(items:readonly ({close():Promise<void>}|null)[]):Promise<void> {
  const closing=items.flatMap(item=>{if(!item)return[];try{return[item.close()];}catch(e){return[Promise.reject(e)];}});
  const failed=(await Promise.allSettled(closing)).find(r=>r.status==="rejected");if(failed)throw failed.reason;
}
function localCapabilities(config:LocalDaemonConfig):LocalCapabilities {
  return createLocalCapabilities({dataDir:config.dataDir,policy:config.policy,
    ...(config.files?{files:{policy:config.files.policy}}:{}),
    ...(config.browser?{browser:{driver:new ChromePipeDriver(config.browser)}}:{}),
    ...(config.cua?{cua:{transport:()=>new CuaHelperProcess(config.cua!)}}:{})});
}
function readPairingLine(signal:AbortSignal):Promise<{offerId:string;code:string}> {
  return new Promise((resolve,reject)=>{
    let bytes=Buffer.alloc(0);const timer=setTimeout(()=>finish(new DeviceError("timeout","pairing input timed out")),30_000);
    const done=()=>{clearTimeout(timer);process.stdin.off("data",data);process.stdin.off("end",ended);process.stdin.off("error",ended);signal.removeEventListener("abort",aborted);process.stdin.pause();process.stdin.destroy();};
    const finish=(error:DeviceError|null,value?:{offerId:string;code:string})=>{done();if(error)reject(error);else resolve(value!);};
    const aborted=()=>finish(new DeviceError("unavailable","pairing input aborted")),ended=()=>finish(new DeviceError("invalid_input","pairing input missing"));
    const data=(chunk:Buffer)=>{if(bytes.length+chunk.length>4096){finish(new DeviceError("invalid_input","pairing input refused"));return;}bytes=Buffer.concat([bytes,chunk]);const at=bytes.indexOf(10);if(at<0)return;
      try{const v=exact(JSON.parse(bytes.subarray(0,at).toString("utf8")),["offerId","code"]);if(typeof v.code!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(v.code))throw new DeviceError("invalid_input","pairing input refused");finish(null,{offerId:wireId(v.offerId),code:v.code});}catch{finish(new DeviceError("invalid_input","pairing input refused"));}};
    process.stdin.on("data",data);process.stdin.once("end",ended);process.stdin.once("error",ended);signal.addEventListener("abort",aborted,{once:true});if(signal.aborted)aborted();else process.stdin.resume();
  });
}
export async function main(argv:readonly string[],dependencies:DaemonMainDependencies={}):Promise<number> {
  const output=dependencies.emit??emit,controller=new AbortController(),signal=dependencies.signal?AbortSignal.any([controller.signal,dependencies.signal]):controller.signal;
  const terminate=()=>controller.abort();let caps:LocalCapabilities|null=null,daemon:DaemonLifecycle|null=null,client:NativeClientHandle|null=null;
  // Persistent handlers: a repeated signal during drain only repeats the same stop request, never the default force exit.
  process.on("SIGTERM",terminate);process.on("SIGINT",terminate);
  const cancelled=()=>{if(signal.aborted)throw new DeviceError("unavailable","daemon startup aborted");};
  try {
    const args=parseDaemonArguments(argv),config=readDaemonConfig(args.configPath);cancelled();
    // Transient owner startup intent only, never persisted or exposed as a bot operation.
    if(args.prepareCua&&(config.mode!=="local-capabilities"||config.cua?.mode!=="native"||config.client.kind!=="native-helper"||config.client.identityMode!=="production"))throw new DeviceError("unsupported","owner CUA preparation unavailable");
    let selection:TrustedClientSelection;
    if(config.client.kind==="native-helper"){
      // Main owns the client until a daemon constructor succeeds; pairing only borrows it. Never a PEM fallback.
      const native=config.client;client=(dependencies.createNativeClient??(options=>new NativeDeviceClient(options)))({executable:native.executable,configPath:native.configPath,installationID:native.installationID,...(native.identityMode?{identityMode:native.identityMode}:{})});
      confirmNativeSelection(native,config.trust);
      // The client's own typed pin must be the outer trust (and therefore the binding's, checked pre-state).
      const bound=readBinding(config.dataDir);if(client.hostFingerprint!==config.trust.hostFingerprint||(bound&&bound.hostFingerprint!==client.hostFingerprint))throw new DeviceError("tls_pin_mismatch","native client pin refused");cancelled();
      // Exactly one public load before pairing or the daemon; every later request carries this fingerprint.
      const loaded=await client.loadOnly(30_000,signal);cancelled();bindNativeDevice(config.dataDir,loaded.fingerprint);cancelled();selection={client};
    } else {selection={identity:(dependencies.loadIdentity??loadIdentity)(config.client.identityDir)};cancelled();}
    if(args.pair||readBinding(config.dataDir)===null){const offer=await(dependencies.readPairingLine??readPairingLine)(signal);cancelled();output({event:"claiming"});
      const binding=await(dependencies.pairDevice??pairDevice)({...selection,dataDir:config.dataDir,trust:config.trust,...offer,name:config.name,capabilities:config.capabilities,signal});cancelled();
      // The approved device must belong to the helper's installation; a mismatched binding is never served.
      if(config.client.kind==="native-helper"&&binding.installationId!==config.client.installationID)throw new DeviceError("conflict","paired installation refused");
      output({event:"paired",deviceId:binding.deviceId});}
    cancelled();
    if(config.mode!=="laboratory")caps=(dependencies.createCapabilities??localCapabilities)(config);
    if(args.prepareCua){if(!caps?.cua)throw new DeviceError("unsupported","owner CUA preparation unavailable");caps.cua.prepareForOwner();}
    cancelled();daemon=(dependencies.createDaemon??(options=>new MacDeviceDaemon(options)))({...selection,dataDir:config.dataDir,trust:config.trust,
      handlers:config.mode==="laboratory"?createFixtureHandlers({root:config.fixtureRoot,enable:config.capabilities}):new Map([...caps!.handlers].filter(([tool])=>config.capabilities.includes(tool))),...(caps?{resources:[caps]}:{})});
    client=null; // A successful daemon constructor owns the client; only daemon.stop drains it from here on.
    cancelled();let stopListener:()=>void=()=>{};
    const stopped=new Promise<string|null>(resolve=>{daemon!.start(resolve);});
    const signalled=new Promise<string>(resolve=>{stopListener=()=>resolve("signal");signal.addEventListener("abort",stopListener,{once:true});if(signal.aborted)stopListener();});
    output({event:"ready",deviceId:daemon.binding.deviceId,...(config.mode==="laboratory-browser"?{executionMode:"laboratory-browser",identityMode:"laboratory-native"}:{})});let reason:string|null;
    try{reason=await Promise.race([stopped,signalled]);}finally{signal.removeEventListener("abort",stopListener);}
    await daemon.stop();output({event:"stopped",reason:reason??"stopped"});return reason==="forbidden"||reason==="tls_pin_mismatch"?3:0;
  } catch(error) {
    // Never close local resources or the client independently of an existing daemon's effect/journal drain.
    let failure=error;try{if(daemon)await daemon.stop();else await closeAll([client,caps]);}catch(cleanup){failure=cleanup;}
    output({event:"error",code:failure instanceof DeviceError?failure.code:"unavailable"});return argv.length<2?2:1;
  } finally {process.off("SIGTERM",terminate);process.off("SIGINT",terminate);}
}
// /tmp and /var are aliases on macOS; entry detection must compare canonical filenames.
if(process.argv[1]){try{if(realpathSync(new URL(import.meta.url))===realpathSync(process.argv[1]))main(process.argv.slice(2)).then(code=>{process.exitCode=code;},()=>{process.exitCode=1;});}catch{/* Imported libraries never run a daemon implicitly. */}}
