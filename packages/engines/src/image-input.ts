import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ImageAttachmentSchema, MAX_MESSAGE_ATTACHMENTS } from "@dexter/contracts";
import type { EngineImageInput } from "./index.js";
import { EngineError } from "./process.js";

/** Native image payloads can be produced only by trusted composition, never a path/base64 in model arguments. */
export function checkedImageInputs(threadId:string,input:readonly EngineImageInput[]):{image:EngineImageInput;data:Buffer}[] {
  if(input.length>MAX_MESSAGE_ATTACHMENTS || new Set(input.map(image=>image.id)).size!==input.length)throw new EngineError("protocol_error");
  return input.map(image=>{
    const {data,localPath,...metadata}=image;
    if(!ImageAttachmentSchema.safeParse(metadata).success || image.threadId!==threadId || !(data instanceof Uint8Array)
      || data.byteLength!==image.bytes || createHash("sha256").update(data).digest("hex")!==image.sha256)throw new EngineError("protocol_error");
    return{image:{...metadata,...(localPath===undefined?{}:{localPath})},data:Buffer.from(data)};
  });
}
/** Codex consumes a local PNG path; recheck the exact owned regular-file bytes before sending that path. */
export function checkedLocalImagePath(image:EngineImageInput):string {
  if(typeof image.localPath!=="string" || !isAbsolute(image.localPath) || !image.localPath.endsWith(".png"))throw new EngineError("protocol_error");
  let fd:number|undefined;
  try{
    fd=openSync(image.localPath,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.nlink!==1 || stat.size!==image.bytes)throw new Error();
    if(createHash("sha256").update(readFileSync(fd)).digest("hex")!==image.sha256)throw new Error();
    return image.localPath;
  }catch{throw new EngineError("protocol_error");}finally{if(fd!==undefined)closeSync(fd);}
}
