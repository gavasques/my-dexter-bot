import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ownerControlRequest } from "./owner-control-client.js";
import { currentUid, validateOwnerControlPath } from "./owner-control.js";
import { maintenanceResultPath, type OwnerMaintenanceResult } from "./owner-authority-maintenance.js";
/** Local operator only; no store, custody, coordinator, catalog or receipt can be selected through argv. */
export async function runAuthorityOwnerCli(args:string[],io:{stdout(text:string):void}):Promise<number> {
  let socket:string,artifact:string,destination:string,requestId:string;
  try {
    if(args[0]!=="transfer")throw new Error();
    const {values,positionals}=parseArgs({args:args.slice(1),allowPositionals:true,strict:true,options:{"owner-control-socket":{type:"string"},artifact:{type:"string"},destination:{type:"string"},"request-id":{type:"string"}}});
    if(positionals.length || !values.artifact || !values.destination)throw new Error();
    socket=validateOwnerControlPath(values["owner-control-socket"]); artifact=values.artifact; destination=values.destination; requestId=values["request-id"]??randomUUID();
  }catch{io.stdout(JSON.stringify({status:"not_sent",code:"invalid_input"})+"\n");return 2;}
  const outcome=await ownerControlRequest(socket,{op:"authority.transfer",args:{requestId,artifactPath:artifact,destinationPath:destination}});
  if(outcome.kind!=="response") {io.stdout(JSON.stringify({status:outcome.kind,requestId})+"\n");return 3;}
  if(!outcome.response.ok){io.stdout(JSON.stringify(outcome.response)+"\n");return 2;}
  const ack=outcome.response.result,resultPath=maintenanceResultPath(artifact);
  if(ack.status!=="accepted" || ack.requestId!==requestId || ack.resultPath!==resultPath){io.stdout(JSON.stringify({status:"unknown",requestId})+"\n");return 3;}
  const until=Date.now()+60_000;
  while(Date.now()<until) {
    let fd:number|undefined;
    try {
      fd=openSync(resultPath,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);
      if(!st.isFile() || st.uid!==currentUid() || (st.mode&0o077)!==0 || st.size>8192)throw new Error();
      const r=JSON.parse(readFileSync(fd,"utf8")) as OwnerMaintenanceResult;
      if(r.protocol!=="dexter-owner-maintenance-v1" || r.requestId!==requestId || !["source_revoked","failed_before_revoke","revoked_cleanup_incomplete","drain_incomplete"].includes(r.status))throw new Error();
      if((r.checkpointId!==null && (typeof r.checkpointId!=="string" || !/^ckp_[A-Za-z0-9_-]{16,64}$/.test(r.checkpointId))) || (r.artifactSha256!==null && (typeof r.artifactSha256!=="string" || !/^[0-9a-f]{64}$/.test(r.artifactSha256))) || (r.sourceEpoch!==null && (!Number.isSafeInteger(r.sourceEpoch) || r.sourceEpoch<1)))throw new Error();
      const acks=r.relayPendingAcks;
      if(!(acks===null || acks==="unavailable" || (typeof acks==="object" && !Array.isArray(acks) && Object.keys(acks).length<=8 && Object.entries(acks).every(([k,v])=>/^[a-z_]{1,40}$/.test(k) && Number.isSafeInteger(v) && v>=0))))throw new Error();
      // Bound public projection; never echo arbitrary file fields.
      io.stdout(JSON.stringify({status:r.status,requestId,checkpointId:r.checkpointId,artifactSha256:r.artifactSha256,sourceEpoch:r.sourceEpoch,relayPendingAcks:acks,resultPath})+"\n");return r.status==="source_revoked"?0:4;
    } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT" && !(e instanceof SyntaxError)) {io.stdout(JSON.stringify({status:"unknown",requestId})+"\n");return 3;} }
    finally {if(fd!==undefined)closeSync(fd);}
    await delay(25);
  }
  io.stdout(JSON.stringify({status:"unknown",requestId,resultPath})+"\n");return 3;
}
