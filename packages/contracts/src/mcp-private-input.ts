import { z } from "zod";
const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
export function mcpPrivateStringIsWellFormed(text:string):boolean {
  for(let i=0;i<text.length;i++) {
    const unit=text.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}
    else if(unit>=0xdc00&&unit<=0xdfff)return false;
  }
  return true;
}
/** A canonical journal row includes the bounded form record AND its host envelope, including terminal receipt fields.
 * Native admission already bounds each of <=8 original schemas to 64 KiB of JSON and messages to 2048 UTF-16
 * units (<=12 KiB escaped JSON each). Their complete stripped record plus the <=4 KiB envelope is <640 KiB.
 * 1 MiB therefore preserves all admitted R5/R6 forms, including escaped control strings, without truncation.
 * Metadata scans count decoded UTF-8/key bytes/nodes, not escaped JSON bytes: reserve envelope headroom there too. */
export const MCP_PRIVATE_INPUT_JOURNAL_LIMITS=Object.freeze({maxBytes:1024*1024,envelopeBytes:4096,
  metadataBytes:256*1024+4096,metadataNodes:20_064,metadataDepth:25});
/** Dedicated private routes only. A response is one canonical row. Each of <=8 accepted answer contents already
 * passes checkNativeMcpArguments' 64 KiB canonical budget; 4 KiB covers eight 128-byte keys + closed wrappers/origin. */
export const MCP_PRIVATE_INPUT_WIRE_LIMITS=Object.freeze({pageSize:100,pageBytes:262_144,
  responseBytes:MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes+4096,answerBytes:8*65_536+4096});
/** Canonical sorting changes key order only, so compact JSON and canonical JSON have the same UTF-8 length.
 * This measures the actual JSON escaping, never a decoded-text or JavaScript string-length approximation. */
export function mcpPrivateInputCanonicalBytes(value:unknown):number {
  try{const encoded=JSON.stringify(value);return encoded===undefined?Infinity:new TextEncoder().encode(encoded).byteLength;}
  catch{return Infinity;}
}
export function mcpPrivateInputRequestsFitJournal(requests:unknown):boolean {
  return mcpPrivateInputCanonicalBytes(requests)<=MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes-MCP_PRIVATE_INPUT_JOURNAL_LIMITS.envelopeBytes;
}
/** Only the form definition is journaled. Opaque provider _meta remains process-local with the originating RPC. */
export function mcpPrivateInputJournalRequests(requests:Record<string,unknown>):Record<string,unknown> {
  return Object.fromEntries(Object.entries(requests).map(([key,value])=>{
    const request=value as {method:string;params:{mode?:string;message:string;requestedSchema:unknown}};
    return[key,{method:request.method,params:{...(request.params.mode===undefined?{}:{mode:request.params.mode}),message:request.params.message,requestedSchema:request.params.requestedSchema}}];
  }));
}
const reserved=new Set(["__proto__","prototype","constructor"]);
export function mcpPrivateInputRequestIdIsValid(value:string):boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value)&&!reserved.has(value);
}
/** All strings, including metadata and keys, must survive JSON→Swift without replacement/loss. */
export function mcpPrivateInputJsonIsLossless(raw:unknown):boolean {
  let nodes=0;const seen=new Set<object>();
  const visit=(value:unknown,depth:number):boolean=>{
    if(++nodes>20_000||depth>24)return false;
    if(typeof value==="string")return mcpPrivateStringIsWellFormed(value);
    if(value===null||typeof value==="boolean")return true;
    if(typeof value==="number")return Number.isFinite(value);
    if(!value||typeof value!=="object"||seen.has(value))return false;
    seen.add(value);
    const safe=Array.isArray(value)?value.every(v=>visit(v,depth+1))
      :Object.getPrototypeOf(value)===Object.prototype&&Object.entries(value).every(([key,v])=>!reserved.has(key)&&mcpPrivateStringIsWellFormed(key)&&visit(v,depth+1));
    seen.delete(value);return safe;
  };
  return visit(raw,0);
}
// Validate BEFORE z.record/z.json: those parsers intentionally drop __proto__. No accepted record may lose keys.
const record=z.unknown().superRefine((raw,ctx)=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype
    ||Object.keys(raw).length<1||Object.keys(raw).length>8||!Object.keys(raw).every(mcpPrivateInputRequestIdIsValid)||!mcpPrivateInputJsonIsLossless(raw))
    ctx.addIssue({code:"custom",message:"Private input record is not lossless JSON."});
}).pipe(z.record(z.string(),z.json()));
const state=z.enum(["pending","answered","declined","cancelled","expired","interrupted"]);
const fields={version:z.literal(1),id,actionId:id,requestHash:hash,connectionId:id,botId:id,threadId:id,
  revision:z.number().int().positive(),state,createdAt:z.number().int().nonnegative(),expiresAt:z.number().int().nonnegative(),
  responseHash:hash.nullable(),clientRequestId:z.string().uuid().nullable()};
/** Only recovery classifiers may read the envelope without trusting/rendering its request payload. */
export const McpPrivateInputJournalEnvelopeSchema=z.strictObject({...fields,requests:z.unknown()});
export const McpPrivateInputSchema=z.strictObject({...fields,requests:record}).superRefine((value,context)=>{
  if(!mcpPrivateInputRequestsFitJournal(value.requests)||mcpPrivateInputCanonicalBytes(value)>MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes)
    context.addIssue({code:"custom",message:"Private input journal exceeds its canonical UTF-8 budget."});
});
export type McpPrivateInput=z.infer<typeof McpPrivateInputSchema>;
/** Metadata is deliberately NOT an assertion that the unhydrated request body is valid/actionable. */
export const McpPrivateInputSummarySchema=z.strictObject({...fields,detailState:z.literal("not_loaded")});
export type McpPrivateInputSummary=z.infer<typeof McpPrivateInputSummarySchema>;
export const McpPrivateInputPageQuerySchema=z.strictObject({view:z.enum(["active","history"]).default("active"),
  after:id.optional(),limit:z.coerce.number().int().min(1).max(MCP_PRIVATE_INPUT_WIRE_LIMITS.pageSize).default(100)});
export type McpPrivateInputPageQuery=z.input<typeof McpPrivateInputPageQuerySchema>;
export const McpPrivateInputQuarantineSchema=z.strictObject({version:z.literal(1),id,actionId:id,requestHash:hash,connectionId:id,botId:id,threadId:id,
  state:z.literal("quarantined"),previousState:state,previousRevision:z.number().int().positive(),createdAt:z.number().int().nonnegative(),expiresAt:z.number().int().nonnegative(),
  responseHash:hash.nullable(),clientRequestId:z.string().uuid().nullable(),rawHash:hash,
  reason:z.enum(["lost_request_keys","reserved_request_key","ill_formed_unicode","escaped_end_anchor"]),quarantinedAt:z.number().int().nonnegative()});
export type McpPrivateInputQuarantine=z.infer<typeof McpPrivateInputQuarantineSchema>;
export const RespondMcpPrivateInputSchema=z.strictObject({expectedHostID:id,clientRequestId:z.string().uuid(),expectedRevision:z.number().int().positive(),
  actionId:id,requestHash:hash,responses:record,
  approval:z.literal("approve_exact_input").optional()}).superRefine((value,context)=>{
    if(Object.values(value.responses).some(r=>r!==null&&typeof r==="object"&&!Array.isArray(r)&&r.action==="accept")&&value.approval!=="approve_exact_input")
      context.addIssue({code:"custom",path:["approval"],message:"Exact private input approval required."});
  });
