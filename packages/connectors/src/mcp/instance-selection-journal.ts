import type { DatabaseSync } from "node:sqlite";
import { McpInstanceSelectionJournalSchema, type McpInstanceSelectionJournal } from "@dexter/contracts";
import { McpConnectorError } from "./errors.js";
import { mcpSetupCanonicalJSON, mcpSetupHash, NATIVE_MCP_RECEIPTS_SQL } from "./setup-receipts.js";
export const NATIVE_MCP_INSTANCE_SCHEMA_VERSION = "3";
export const MCP_INSTANCE_SELECTION_RECEIPT_LIMIT = 256;
export const MCP_INSTANCE_SELECTION_HEAD_LIMIT = 256;
export const MCP_INSTANCE_SELECTION_SQL = `CREATE TABLE instance_selection_heads(
 bot_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), selection_hash TEXT NOT NULL) STRICT;
CREATE TABLE instance_selection_receipts(
 action_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, receipt TEXT NOT NULL, receipt_hash TEXT NOT NULL) STRICT;`;
// First-party schema2 SQL, kept exact here so schema3 never accepts arbitrary tables by ignoring their names.
const BASE = `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE servers(id TEXT PRIMARY KEY, definition TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('configured','ready','failed','needs_auth','deleting'))) STRICT;
CREATE TABLE catalogs(server_id TEXT PRIMARY KEY, tools TEXT NOT NULL) STRICT;
CREATE TABLE connections(server_id TEXT NOT NULL, profile_id TEXT NOT NULL, connection_id TEXT NOT NULL, PRIMARY KEY(server_id, profile_id)) STRICT;
CREATE TABLE selections(server_id TEXT NOT NULL, bot_id TEXT NOT NULL, tools TEXT NOT NULL, PRIMARY KEY(server_id, bot_id)) STRICT;`;
const conflict = (): never => { throw new McpConnectorError("store_conflict"); };
const pinSQL = (sql: string): string => {
 let out="",quoted=false;
 for(let i=0;i<sql.length;i++){const c=sql[i]!;if(c==="'"){out+=c;if(quoted&&sql[i+1]==="'"){out+="'";i++;}else quoted=!quoted;}
 else if(quoted)out+=c;else if(!/[\s;]/.test(c))out+=c.toLowerCase();}
 return out.replace(/^createtableifnotexists/,"createtable");
};
let expected: Map<string,string> | undefined;
export function validateMcpInstanceSelectionSchema(db: DatabaseSync): void {
 if(!expected){
  // Import constructor lazily is unnecessary: derive the eight closed table fragments from first-party DDL.
  expected=new Map((BASE+NATIVE_MCP_RECEIPTS_SQL+MCP_INSTANCE_SELECTION_SQL).split(/;\s*/).filter(Boolean).map(sql=>{
   const name=/CREATE TABLE\s+(\w+)/i.exec(sql)?.[1];if(!name)return conflict();return[name,pinSQL(sql)];
  }));
 }
 const rows=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
 if(rows.length!==expected.size || rows.some(r=>r.type!=="table"||typeof r.name!=="string"||typeof r.sql!=="string"||expected!.get(r.name)!==pinSQL(r.sql))
  || db.prepare("PRAGMA user_version").get()?.user_version!==0)conflict();
}
export function readMcpInstanceSelectionRow(row: Record<string,unknown>): McpInstanceSelectionJournal {
 try {
  if(typeof row.receipt!=="string"||Buffer.byteLength(row.receipt)>262144)return conflict();
  const j=McpInstanceSelectionJournalSchema.parse(JSON.parse(row.receipt));
  if(row.action_id!==j.actionId||row.bot_id!==j.botId||row.receipt_hash!==mcpSetupHash(j)||row.receipt!==mcpSetupCanonicalJSON(j)
   || j.requestHash!==mcpSetupHash({operation:j.operation,plan:j.plan}) ||new Set(j.steps.map(s=>s.toolId+"\0"+s.connectionId)).size!==j.steps.length)return conflict();
  const desired=new Set(j.plan.targets.flatMap(t=>t.toolIds.map(n=>n+"\0"+t.connectionId)));
  const ask=new Set(j.steps.filter(s=>s.policy==="ask").map(s=>s.toolId+"\0"+s.connectionId));
  const retained=new Set(j.retainedGrants.map(s=>s.toolId+"\0"+s.connectionId));
  if(retained.size!==j.retainedGrants.length||[...ask].some(k=>!desired.has(k)||retained.has(k))||[...retained].some(k=>!desired.has(k))
    ||desired.size!==ask.size+retained.size||j.retainedGrants.some(g=>g.grant.policy==="deny")
    ||j.steps.some(s=>!s.toolId.startsWith("mcp."+s.serverId+".")||s.policy==="deny"&&desired.has(s.toolId+"\0"+s.connectionId)))return conflict();
  return j;
 }catch{return conflict();}
}
export function validateMcpInstanceSelectionRows(db: DatabaseSync): void {
 const heads=db.prepare("SELECT * FROM instance_selection_heads").all(),rows=db.prepare("SELECT * FROM instance_selection_receipts").all();
 if(heads.length>MCP_INSTANCE_SELECTION_HEAD_LIMIT||rows.length>MCP_INSTANCE_SELECTION_RECEIPT_LIMIT)conflict();
 const ids=new Set<string>(),byBot=new Map<string,McpInstanceSelectionJournal[]>();
 for(const row of rows){const j=readMcpInstanceSelectionRow(row);if(ids.has(j.receiptId))conflict();ids.add(j.receiptId);byBot.set(j.botId,[...(byBot.get(j.botId)??[]),j]);}
 for(const head of heads){const list=(byBot.get(String(head.bot_id))??[]).sort((a,b)=>a.revision-b.revision);const last=list.at(-1);
  if(!last||list.some((j,i)=>j.revision!==i+1||j.profileId!==head.profile_id)||last.revision!==head.revision||mcpSetupHash(last.plan.targets)!==head.selection_hash)conflict();}
 if(byBot.size!==heads.length)conflict();
 for(const r of heads)if(typeof r.bot_id!=="string"||typeof r.profile_id!=="string"||![r.bot_id,r.profile_id].every(id=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id as string))
  ||!Number.isSafeInteger(r.revision)||Number(r.revision)<1||typeof r.selection_hash!=="string"||!/^[0-9a-f]{64}$/.test(r.selection_hash))conflict();
}
export function putMcpInstanceSelectionJournal(db: DatabaseSync,j:McpInstanceSelectionJournal):void {
 const value=McpInstanceSelectionJournalSchema.parse(j),serialized=mcpSetupCanonicalJSON(value);
 if(Buffer.byteLength(serialized)>262144)conflict();
 db.prepare("INSERT INTO instance_selection_receipts VALUES(?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET receipt=excluded.receipt,receipt_hash=excluded.receipt_hash")
  .run(value.actionId,value.botId,serialized,mcpSetupHash(value));
}
