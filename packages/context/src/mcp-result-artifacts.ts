import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@dexter/contracts";
import { ContextError } from "./types.js";

export const MCP_RESULT_ARTIFACT_LIMITS=Object.freeze({bytes:1_048_576,totalBytes:16_777_216,count:128,ttlMs:3_600_000,readChars:8192});
interface Entry {version:1;id:string;botId:string;threadId:string;actionId:string;requestHash:string;sha256:string;expiresAt:number;content:string}
/** Private bounded spill of already sanitized receipts. No URL fetch, memory capture or sharing via Team membership. */
export class McpResultArtifacts {
  readonly #directory:string;
  readonly #inode:bigint;
  constructor(dataDir:string,readonly now:()=>number=Date.now){
    this.#directory=join(dataDir,"mcp-result-artifacts");mkdirSync(this.#directory,{mode:0o700,recursive:true});
    const stat=lstatSync(this.#directory,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||Number(stat.uid)!==process.getuid?.())throw new ContextError("forbidden");this.#inode=stat.ino;
  }
  #root(){const stat=lstatSync(this.#directory,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==this.#inode)throw new ContextError("tampered");}
  #load(id:string):Entry {
    if(!/^mcpa_[a-f0-9]{48}$/.test(id))throw new ContextError("invalid_input");this.#root();
    const fd=openSync(join(this.#directory,`${id}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>MCP_RESULT_ARTIFACT_LIMITS.bytes+4096||stat.uid!==process.getuid?.())throw new ContextError("tampered");
      const e=JSON.parse(readFileSync(fd,"utf8")) as Entry;
      if(e.version!==1||e.id!==id||typeof e.content!=="string"||![e.botId,e.threadId,e.actionId].every(v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v))
        ||!Number.isSafeInteger(e.expiresAt)||!/^[a-f0-9]{64}$/.test(e.requestHash)||createHash("sha256").update(e.content).digest("hex")!==e.sha256)throw new ContextError("tampered");return e;
    }finally{closeSync(fd);}
  }
  #entries():Entry[]{this.#root();const names=readdirSync(this.#directory).filter(n=>/^mcpa_[a-f0-9]{48}\.json$/.test(n));if(names.length>256)throw new ContextError("conflict");return names.map(n=>this.#load(n.slice(0,-5)));}
  save(input:{botId:string;threadId:string;actionId:string;requestHash:string;content:JsonValue}):JsonValue|null {
    this.#root();const content=JSON.stringify(input.content),bytes=Buffer.byteLength(content);if(bytes>MCP_RESULT_ARTIFACT_LIMITS.bytes)return null;
    const id=`mcpa_${createHash("sha256").update(JSON.stringify([input.botId,input.threadId,input.actionId,input.requestHash,content])).digest("hex").slice(0,48)}`;
    const all=this.#entries(),existing=all.find(e=>e.id===id);if(existing)return existing.expiresAt>this.now()?{artifactId:id,sha256:existing.sha256,expiresAt:existing.expiresAt,bytes}:null;
    for(const e of all)if(e.expiresAt<=this.now())unlinkSync(join(this.#directory,`${e.id}.json`));
    const alive=all.filter(e=>e.expiresAt>this.now());if(alive.length>=MCP_RESULT_ARTIFACT_LIMITS.count||alive.reduce((n,e)=>n+Buffer.byteLength(e.content),0)+bytes>MCP_RESULT_ARTIFACT_LIMITS.totalBytes)return null;
    const entry:Entry={version:1,id,botId:input.botId,threadId:input.threadId,actionId:input.actionId,requestHash:input.requestHash,sha256:createHash("sha256").update(content).digest("hex"),expiresAt:this.now()+MCP_RESULT_ARTIFACT_LIMITS.ttlMs,content};
    // JSON escaping may double the storage size: enforce the actual on-disk envelope bound as well.
    const encoded=JSON.stringify(entry);if(Buffer.byteLength(encoded)>MCP_RESULT_ARTIFACT_LIMITS.bytes+4096)return null;
    writeFileSync(join(this.#directory,`${id}.json`),encoded,{encoding:"utf8",mode:0o600,flag:"wx"});return {artifactId:id,sha256:entry.sha256,expiresAt:entry.expiresAt,bytes};
  }
  read(botId:string,threadId:string,id:string,offset=0):JsonValue {
    const entry=this.#load(id);if(entry.botId!==botId||entry.threadId!==threadId)throw new ContextError("forbidden");if(entry.expiresAt<=this.now())throw new ContextError("not_found");
    if(!Number.isSafeInteger(offset)||offset<0||offset>entry.content.length)throw new ContextError("invalid_input");
    const end=Math.min(entry.content.length,offset+MCP_RESULT_ARTIFACT_LIMITS.readChars);
    return {artifactId:id,sha256:entry.sha256,expiresAt:entry.expiresAt,format:"json_text",offset,content:entry.content.slice(offset,end),nextOffset:end<entry.content.length?end:null};
  }
  remove(botId:string,threadId:string,id:string):JsonValue {
    const entry=this.#load(id);if(entry.botId!==botId||entry.threadId!==threadId)throw new ContextError("forbidden");this.#root();unlinkSync(join(this.#directory,`${id}.json`));return {artifactId:id,removed:true};
  }
}
