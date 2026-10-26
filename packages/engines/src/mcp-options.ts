import { isAbsolute, resolve } from 'node:path';
import { EngineError } from './process.js';
/** Native clients must outlive the host bridge's pending-receipt response. */
export const LOCAL_MCP_CLIENT_TIMEOUT_MS = 300_000;
/** Host-owned local transport only. Never pass connection authority in these fields. */
export interface NativeMcpServer { readonly command: string; readonly args: readonly string[] }
/** Exact first-party directory names, never a wildcard allowing arbitrary provider meta-tools. */
export function isDexterGatewayToolName(name: string): boolean {
  return /^mcp__dexter_gateway__(?:dx_[0-9a-f]{24}|dx_catalog_(?:search|describe|call))$/.test(name);
}
/** Read only explicit provider tool-result payloads. Never scan assistant prose for delivery evidence. */
export function gatewayReceiptEvidence(value:unknown):Array<{actionId:string;requestHash:string;status:string}> {
  const result:Array<{actionId:string;requestHash:string;status:string}>=[];
  const visit=(item:unknown,depth:number):void=>{
    if(depth>4 || result.length>=32)return;
    if(typeof item==="string"){
      if(Buffer.byteLength(item)>1024*1024)return;
      try{visit(JSON.parse(item),depth+1);}catch{}return;
    }
    if(Array.isArray(item)){for(const block of item.slice(0,32))visit(block,depth+1);return;}
    if(!item || typeof item!=="object")return;
    const row=item as Record<string,unknown>;
    if(typeof row.actionId==="string" && /^act_[A-Za-z0-9_-]{1,128}$/.test(row.actionId)
      && typeof row.requestHash==="string" && /^[a-f0-9]{64}$/.test(row.requestHash)
      && typeof row.status==="string" && ["succeeded","denied","blocked","unknown"].includes(row.status)){
      result.push({actionId:row.actionId,requestHash:row.requestHash,status:row.status});return;
    }
    if(row.structuredContent!==undefined)visit(row.structuredContent,depth+1);
    if(row.content!==undefined)visit(row.content,depth+1);
    if(row.type==="text" && typeof row.text==="string")visit(row.text,depth+1);
  };visit(value,0);return result;
}
export function validateNativeMcpServer(value: NativeMcpServer): NativeMcpServer {
  try {
    if (!value || Object.keys(value).some(key => !['command', 'args'].includes(key))) throw new Error();
    // Read caller properties once. Validate and freeze this snapshot, never reread getters/proxies.
    const command: unknown = value.command;
    const source: unknown = value.args;
    if (!Array.isArray(source) || source.length !== 2) throw new Error();
    const args: unknown[] = [source[0], source[1]];
    if (typeof command !== 'string' || /[\x00-\x1f$]/.test(command) || command !== process.execPath || args.some(path => typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f$]/.test(path)) || Buffer.byteLength(args[1] as string) > 100 || process.platform === 'win32') throw new Error();
    return Object.freeze({ command, args: Object.freeze(args as string[]) });
  } catch { throw new EngineError('protocol_error'); }
}
