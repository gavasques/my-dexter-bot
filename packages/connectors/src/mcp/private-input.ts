import { checkNativeMcpSchema, checkNativeMcpArguments, type AdapterCall } from "@dexter/gateway";
import { McpConnectorError } from "./errors.js";
import { assertSafeMcpMetadata } from "./metadata-security.js";
import { validateNativeMcpArguments, assertSupportedMcpSchema } from "./schema.js";
import { mcpPrivateInputJsonIsLossless, mcpPrivateInputRequestIdIsValid, mcpPrivateInputJournalRequests, mcpPrivateInputRequestsFitJournal } from "@dexter/contracts";
export interface McpPrivateInputHandler {
  /** Trusted private UI handoff. Must gather exact user consent; the model cannot supply these responses. */
  request(call: AdapterCall, inputRequests: Readonly<Record<string,unknown>>, signal: AbortSignal,
    /** Trusted session-only, current-custody validation. The owner host invokes this before consuming its pending
     * wait/receipt. Never supplied in JSON, persisted, or treated as a grant; the session validates again afterward. */
    validateResponses?: (responses:Record<string,unknown>)=>void): Promise<Record<string,unknown>>;
  /** Re-check original action, capability, connection/grant revision and tool pin immediately before a round. */
  authorized(call: AdapterCall): boolean;
}
const refused=():never=>{throw new McpConnectorError("input_required",null,null,{phase:"dispatch",effect:"possible"});};
/** Custody/authentication fields never belong to a generic MRTR form, even when the value is not known yet. */
function sensitiveFieldName(name:string):boolean {
  const normalized=name.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase();
  const key=normalized.replace(/[^a-z0-9]/g,"");
  return /password|passphrase|passwd|senha|apikey|clientsecret|credential|authorization|bearer|oauth|privatekey|accesskey|authkey|signingkey|encryptionkey|accesstoken|refreshtoken|idtoken|authtoken|sessiontoken|seedphrase|mnemonic/.test(key)
    || key==="secret"||key.startsWith("secret")||key.endsWith("secret")||key==="token"||key.endsWith("token")
    || /token(?:value|secret|key|credential|auth|bearer|access|refresh)|secret(?:key|value|token|password|credential|phrase|confirmation)/.test(key)
    || /^(?:otp|totp|mfacode|authcode|authenticationcode|authenticatorcode|verificationcode|recoverycode|backupcode|securityanswer|pwd|pin|cvv|cookie)$/.test(key)
    || /\b(?:pwd|pin|cvv|cookies?)\b/.test(normalized)||/^(?:pwd|pin|cvv|cookie)(?:confirmation|value|code|number|data|header|s)$/.test(key);
}
function forbiddenFieldName(name:string):boolean {
  const key=name.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase().replace(/[^a-z0-9]/g,"");
  return sensitiveFieldName(name)||["proto","prototype","constructor","user","userid","entity","entityid","owner","ownerid","profile","profileid","bot","botid","account","accountid","connectedaccount","connectedaccountid","connection","connectionid","authconfigid","tool","tools","toolslug","toolname","toolkit","toolkitslug","action","actions","slug","app","integrationid","headers","header","auth","session","sessionid","command","cmd","script","code","shell","eval","exec","program","querycode","bash","url","uri","endpoint","host","hostname","domain","webhook","webhookurl","path","baseurl"].includes(key);
}
/** Bounded solicitation heuristic; plain mentions and nonsecret token measurements do not grant or imply custody. */
function credentialSolicitation(text:string):boolean {
  const normalized=text.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase();
  const credentials=/\b(?:password|passphrase|passwd|pwd|pin|cvv|cookies?|senha|api[ _-]?key|chave[ _-]?(?:de[ _-]?)?api|client[ _-]?secret|(?:access|refresh|id|auth|session)[ _-]?token|bearer|oauth|credentials?|credenciais|secret|segredo|token(?![ _-]+(?:amount|count|budget|limit|cost|usage|quantity|length|type|kind|name|format|price|symbol|quantidade|valor)))\b/g;
  for(const verb of normalized.matchAll(/\b(?:enter|paste|provide|supply|type|input|upload|confirm|insira|cole|informe|forneca|digite|confirme)\b/g)) {
    if(/\b(?:not|never|nao)\s*$/.test(normalized.slice(0,verb.index)))continue;
    const tail=normalized.slice(verb.index+verb[0].length,verb.index+verb[0].length+120).split(/[.!?;\n]/,1)[0]!;
    for(const credential of tail.matchAll(credentials)) {
      if(/\b(?:no|not|without|never|nao|sem|nenhuma?)\s*(?:a|an|any|your|sua?)?\s*$/.test(tail.slice(0,credential.index)))continue;
      return true;
    }
  }
  return false;
}
function assertNonSecretResponseKeys(raw:unknown):void {
  if(!raw||typeof raw!=="object")return;
  if(Array.isArray(raw)){for(const item of raw)assertNonSecretResponseKeys(item);return;}
  for(const [key,value] of Object.entries(raw)){if(sensitiveFieldName(key))return refused();assertNonSecretResponseKeys(value);}
}
const DIALECTS=["http://json-schema.org/draft-07/schema#","https://json-schema.org/draft-07/schema#","https://json-schema.org/draft/2020-12/schema","https://json-schema.org/draft/2020-12/schema#"];
const COMMON=["type","title","description","default"];
const STRING=[...COMMON,"minLength","maxLength","format","pattern","enum","enumNames","oneOf","const"];
const NUMERIC_LIMIT=Number.MAX_SAFE_INTEGER;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const keys=(v:Record<string,unknown>,allowed:readonly string[])=>Object.keys(v).every(k=>allowed.includes(k));
const label=(v:unknown,max:number)=>typeof v==="string"&&v.length<=max&&!sensitiveFieldName(v)&&!credentialSolicitation(v);
const option=(v:unknown)=>typeof v==="string"&&v.length<=200;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v)&&Math.abs(v)<=NUMERIC_LIMIT;
// Swift dictionaries use canonical Unicode equality. ASCII identifiers keep field identity exact in both runtimes;
// Unicode labels and primitive string values are retained byte-for-byte, never normalized or rewritten.
const fieldName=(name:string)=>name.length>0&&name.length<=64&&[...name].every(c=>c.charCodeAt(0)<=127)&&!forbiddenFieldName(name);
/** Portable byte budget: UTF-8 strings and object keys, independent of JSON encoder spelling of numbers/slashes.
 * With this flat contract's 16 fields/64 choices, the remaining JSON punctuation is bounded below 64 KiB. */
function textBytes(value:unknown):number {
  if(typeof value==="string")return Buffer.byteLength(value);
  if(Array.isArray(value))return value.reduce((n,v)=>n+textBytes(v),0);
  if(object(value))return Object.entries(value).reduce((n,[k,v])=>n+Buffer.byteLength(k)+textBytes(v),0);
  return 0;
}
/** Flat-form grammar, also implemented by Swift without evaluating the server's regex. It is a deliberately
 * smaller subset of the native validator: printable ASCII literals, positive ASCII classes, d/w escapes,
 * dot, anchored concatenation and bounded/simple quantifiers. No groups, alternation, lookaround or Unicode.
 * Identical repeated atoms and disjoint literal suffixes stay inside the native static subset; both program budgets are checked.
 */
export function isSupportedMcpPrivateFormPattern(pattern:unknown):boolean {
  if(typeof pattern!=="string"||pattern.length>512||[...pattern].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)>126))return false;
  const anchored=pattern.startsWith("^")&&pattern.endsWith("$");
  let i=anchored?1:0,cost=anchored?2:0,dotCost=0;
  const end=pattern.length-(anchored?1:0),atoms:{source:string;members:Set<string>;literal:string|null;repeat:boolean}[]=[];
  while(i<end) {
    const start=i,c=pattern[i++]!;let members=new Set<string>(),literal:string|null=null;
    if(c==="\\") {
      if(i>=end)return false;
      const escaped=pattern[i++];if(!escaped)return false;
      if(escaped==="d"||escaped==="w") {
        if(!anchored)return false;
        for(const v of escaped==="d"?"0123456789":"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")members.add(v);
      } else if("/.*+?^$()[]{}|\\".includes(escaped)){literal=escaped;members.add(escaped);}else return false;
    } else if(c==="[") {
      if(!anchored)return false;
      const close=pattern.indexOf("]",i);if(close<0||close>=end||close===i)return false;
      const body=pattern.slice(i,close);
      for(let j=0;j<body.length;j++) {
        const v=body[j]!;if(!/[A-Za-z0-9 _-]/.test(v))return false;
        if(body[j+1]==="-"&&j+2<body.length) {
          const last=body[j+2]!;if(!/[A-Za-z0-9 _]/.test(last)||v.charCodeAt(0)>last.charCodeAt(0))return false;
          for(let n=v.charCodeAt(0);n<=last.charCodeAt(0);n++)members.add(String.fromCharCode(n));j+=2;
        }else {if(v==="-"&&j!==0&&j!==body.length-1)return false;members.add(v);}
      }
      i=close+1;
    } else if(c===".") {
      if(!anchored)return false;
      for(let n=32;n<=126;n++)members.add(String.fromCharCode(n));
    } else {
      if("()|{}*+?[]^$".includes(c))return false;literal=c;members.add(c);
    }
    const source=pattern.slice(start,i);let expansion=1,repeat=false;
    if(i<end&&"*+?{".includes(pattern[i]!)) {
      if(!anchored)return false;repeat=true;
      const q=pattern[i++]!;
      if(q==="{") {
        let lower="",upper="";while(i<end&&/[0-9]/.test(pattern[i]!))lower+=pattern[i++];if(!lower)return false;
        if(pattern[i]===","){i++;while(i<end&&/[0-9]/.test(pattern[i]!))upper+=pattern[i++];}
        else upper=lower;
        if(pattern[i++]!=="}")return false;
        const min=Number(lower),max=Number(upper||lower);if(min>max||max>256)return false;expansion=Math.max(1,max);
      }else expansion=q==="?"?1:2;
    }
    cost+=expansion;if(source===".")dotCost+=expansion;
    if(cost>256||dotCost>64)return false;
    atoms.push({source,members,literal,repeat});
  }
  const first=atoms.findIndex(a=>a.repeat);
  if(first>=0)for(const a of atoms.slice(first+1)) {
    const repeated=atoms[first]!;
    if(a.source===repeated.source)continue;
    if(a.repeat||a.literal===null||repeated.members.has(a.literal))return false;
  }
  return true;
}
function scalar(value:unknown):boolean {
  return typeof value==="boolean"||finite(value)||typeof value==="string"&&value.length<=10_000;
}
function assertClosedFormSchema(schema:unknown):asserts schema is Record<string,unknown> {
  if(!object(schema)||textBytes(schema)>32_768||!keys(schema,["type","properties","required","title","description","$schema","additionalProperties"])||schema.type!=="object"||!object(schema.properties)
    ||Object.keys(schema.properties).length>16||schema.$schema!==undefined&&!DIALECTS.includes(schema.$schema as string)
    ||schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=="boolean")return refused();
  for(const [key,max]of [["title",256],["description",2048]]as const)if(schema[key]!==undefined&&!label(schema[key],max))return refused();
  if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.length>16||new Set(schema.required).size!==schema.required.length
    ||schema.required.some(k=>typeof k!=="string"||!Object.hasOwn(schema.properties as object,k))))return refused();
  for(const [name,p]of Object.entries(schema.properties)) {
    if(!fieldName(name)||!object(p))return refused();
    for(const [key,max]of [["title",256],["description",2048]]as const)if(p[key]!==undefined&&!label(p[key],max))return refused();
    if(p.type==="string") {
      if(!keys(p,STRING))return refused();
      for(const key of ["minLength","maxLength"])if(p[key]!==undefined&&(!Number.isInteger(p[key])||(p[key]as number)<0||(p[key]as number)>10_000))return refused();
      if(p.minLength!==undefined&&p.maxLength!==undefined&&(p.minLength as number)>(p.maxLength as number)
        ||p.format!==undefined&&!["email","uri","date","date-time"].includes(p.format as string)||p.pattern!==undefined&&!isSupportedMcpPrivateFormPattern(p.pattern))return refused();
      if(["enum","oneOf","const"].filter(k=>p[k]!==undefined).length>1)return refused();
      if(p.enum!==undefined&&(!Array.isArray(p.enum)||!p.enum.length||p.enum.length>64||!p.enum.every(option)||new Set(p.enum).size!==p.enum.length))return refused();
      if(p.const!==undefined&&!option(p.const))return refused();
      if(p.enumNames!==undefined&&(!Array.isArray(p.enum)||!Array.isArray(p.enumNames)||p.enumNames.length!==p.enum.length||!p.enumNames.every(v=>label(v,200))))return refused();
      if(p.oneOf!==undefined&&(!Array.isArray(p.oneOf)||!p.oneOf.length||p.oneOf.length>64||!p.oneOf.every(v=>object(v)&&keys(v,["const","title"])&&option(v.const)&&label(v.title,200))
        ||new Set(p.oneOf.map(v=>(v as Record<string,unknown>).const)).size!==p.oneOf.length))return refused();
    }else if(p.type==="integer"||p.type==="number") {
      if(!keys(p,[...COMMON,"minimum","maximum"]))return refused();
      for(const key of ["minimum","maximum"])if(p[key]!==undefined&&!finite(p[key]))return refused();
      if(p.minimum!==undefined&&p.maximum!==undefined&&(p.minimum as number)>(p.maximum as number))return refused();
    }else if(p.type!=="boolean"||!keys(p,COMMON))return refused();
    if(p.default!==undefined&&!fieldValue(p,p.default))return refused();
  }
}
function fieldValue(p:Record<string,unknown>,value:unknown):boolean {
  if(!scalar(value))return false;
  if(p.type==="boolean")return typeof value==="boolean";
  if(p.type==="number"||p.type==="integer")return finite(value)&&(p.type!=="integer"||Number.isInteger(value))
    &&(p.minimum===undefined||value>=(p.minimum as number))&&(p.maximum===undefined||value<=(p.maximum as number));
  if(typeof value!=="string")return false;
  const length=[...value].length;
  return(p.minLength===undefined||length>=(p.minLength as number))&&(p.maxLength===undefined||length<=(p.maxLength as number))
    &&(p.enum===undefined||(p.enum as string[]).includes(value))&&(p.const===undefined||p.const===value)
    &&(p.oneOf===undefined||(p.oneOf as Record<string,unknown>[]).some(v=>v.const===value));
}
export function validateMcpPrivateInputRequests(raw:unknown,secrets:readonly string[]=[]): Record<string,unknown> {
  assertSafeMcpMetadata(raw,secrets);
  if(!mcpPrivateInputJsonIsLossless(raw))return refused();
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return refused();
  const requests=raw as Record<string,unknown>,entries=Object.entries(requests);
  if(!entries.length||entries.length>8)return refused();
  for(const [id,value] of entries) {
    if(!mcpPrivateInputRequestIdIsValid(id)||!value||typeof value!=="object"||Array.isArray(value))return refused();
    const r=value as Record<string,unknown>,p=r.params as Record<string,unknown>|undefined;
    if(r.method!=="elicitation/create"||Object.keys(r).some(key=>!["method","params"].includes(key))||!p||typeof p!=="object"||Array.isArray(p)
      ||p.mode!==undefined&&p.mode!=="form"||typeof p.message!=="string"||p.message.length>2048||Object.keys(p).some(key=>!["mode","message","requestedSchema","_meta"].includes(key)))return refused();
    if(credentialSolicitation(p.message))return refused();
    assertClosedFormSchema(p.requestedSchema);
    assertSupportedMcpSchema(p.requestedSchema);
    try{checkNativeMcpSchema(p.requestedSchema);}catch{return refused();}
    const schema=p.requestedSchema as Record<string,unknown>,properties=schema.properties as Record<string,unknown>|undefined;
    if(schema.type!=="object"||!properties||typeof properties!=="object"||Array.isArray(properties)||Object.keys(properties).length>16)return refused();
    for(const property of Object.values(properties)) {
      if(!property||typeof property!=="object"||Array.isArray(property)||!["string","integer","number","boolean"].includes((property as Record<string,unknown>).type as string))return refused();
    }
  }
  if(!mcpPrivateInputRequestsFitJournal(mcpPrivateInputJournalRequests(requests)))return refused();
  return requests;
}
export function validateMcpPrivateInputResponses(requests:Record<string,unknown>,raw:unknown,secrets:readonly string[]=[]):Record<string,unknown> {
  // This check has no new upstream effect. An invalid owner answer must leave the original wait/state intact.
  // The transport still classifies a later continuation failure as possible/after-dispatch for the original action.
  try { return privateInputResponses(requests,raw,secrets); }
  catch(error) {
    if(error instanceof McpConnectorError&&["input_required","input_schema_invalid","metadata_quarantined"].includes(error.code))
      throw new McpConnectorError(error.code,null,null,{phase:"validation",effect:"none",...(error.metadataHash?{metadataHash:error.metadataHash}:{})});
    throw error;
  }
}
function privateInputResponses(requests:Record<string,unknown>,raw:unknown,secrets:readonly string[]):Record<string,unknown> {
  validateMcpPrivateInputRequests(requests,secrets);
  assertSafeMcpMetadata(raw,secrets);
  if(!mcpPrivateInputJsonIsLossless(raw))return refused();
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return refused();
  const responses=raw as Record<string,unknown>;
  if(Object.keys(responses).length!==Object.keys(requests).length)return refused();
  for(const [id,request] of Object.entries(requests)) {
    const response=responses[id] as Record<string,unknown>|undefined;
    if(!response||typeof response!=="object"||Array.isArray(response)||Object.keys(response).some(key=>!["action","content"].includes(key))||!["accept","decline","cancel"].includes(response.action as string))return refused();
    if(response.action==="accept") {
      assertNonSecretResponseKeys(response.content);
      const schema=((request as Record<string,unknown>).params as Record<string,unknown>).requestedSchema as Record<string,unknown>;
      if(!object(response.content)||Object.keys(response.content).length>16||textBytes(response.content)>32_768)return refused();
      const properties=schema.properties as Record<string,Record<string,unknown>>;
      for(const [name,value]of Object.entries(response.content)) {
        if(!fieldName(name))return refused();
        if(Object.hasOwn(properties,name)){if(!fieldValue(properties[name]!,value))throw new McpConnectorError("input_schema_invalid");}
        else if(schema.additionalProperties===false||!scalar(value))return refused();
      }
      try{checkNativeMcpArguments(response.content);}catch{return refused();}
      validateNativeMcpArguments(schema,response.content);
    }
    else if(response.content!==undefined)return refused();
  }
  return responses;
}
