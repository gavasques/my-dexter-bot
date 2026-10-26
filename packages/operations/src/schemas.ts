import { DatabaseSync } from "node:sqlite";
import { checkFullSchema } from "./full-schemas.js";
import { OperationsError, fail } from "./errors.js";

/**
 * Table/column allowlists. Hub v2 is the historical schema of version 1 artifacts only (version 2 artifacts check
 * Hub v3 and the device stores against the exact catalog in `exact.ts`). ContextHost v1 and Agenda v2 are used by
 * both versions. Any other user_version, table, column, trigger or view fails closed. A schema change in those
 * packages must update this allowlist deliberately.
 */
export type DatabaseKind = "hub" | "context" | "agenda";
type Row = Record<string, unknown>;

const HUB_TABLES: Record<string, string> = {
  meta: "key,value",
  host_lease: "id,hostname,pid,token,acquired_at",
  profiles: "id,owner_id,created_at",
  bots: "id,owner_id,profile_id,name,engine,created_at",
  threads: "id,bot_id,created_at",
  messages: "cursor,id,thread_id,client_message_id,role,content,created_at",
  events: "cursor,id,kind,bot_id,thread_id,entity_id,created_at",
  grants: "id,bot_id,tool,destination,policy,expires_at,revision,updated_at",
  devices: "id,owner_id,name,platform,capabilities,created_at,last_seen_at,revoked_at",
  actions: "id,bot_id,thread_id,tool,destination,idempotency_key,request,request_hash,grant_revision,state,created_at,updated_at,approval_expires_at,decided_by,result,reason",
  thread_sessions: "thread_id,engine,native_cursor,created_at,updated_at",
  turns: "cursor,id,thread_id,bot_id,engine,client_request_id,input_hash,input_message_id,output_message_id,state,code,output_chars,output_truncated,created_at,started_at,finished_at,updated_at",
  turn_events: "cursor,turn_id,thread_id,kind,text,data,created_at",
};
const CONTEXT_TABLES: Record<string, string> = {
  meta: "key,value",
  teams: "id,owner_id,name",
  members: "team_id,owner_id,active,revision",
  team_bots: "team_id,bot_id",
  recall_grants: "bot_id,scope_key,allowed,revision",
  memories: "id,scope_json,locale,origin,active,workspace,project,path,hash,git_commit,created_at",
  promotions: "id,source_id,target_json,proposer_bot,request_hash,state,promoted_id,created_at",
  skills: "id,version,hash,git_commit,path",
  activations: "scope_key,skill_id,version,hash",
  artifacts: "id,bot_id,head,fork_id,fork_revision",
  revisions: "artifact_id,revision,hash,git_commit,path,origin,created_at,restored_from",
};
const CONTEXT_DOCUMENT_TABLES:Record<string,string>={...CONTEXT_TABLES,
  bot_documents:"bot_id,revision,soul_pin_json,user_pin_json,memory_pin_json,updated_at",
};
const CONTEXT_V2_TABLES:Record<string,string>={...CONTEXT_DOCUMENT_TABLES,
  bot_document_revisions:"bot_id,revision,soul_pin_json,user_pin_json,memory_pin_json,memory_source_json,restored_from,updated_at",
  bot_document_receipts:"bot_id,operation_key,request_hash,input_json,operation,origin_json,revision,created_at",
};
const AGENDA_TABLES: Record<string, string> = {
  meta: "key,value",
  schedules: "id,owner_id,installation_id,bot_id,thread_id,kind,at,interval_ms,next_at,content,state,revision,created_at,updated_at,last_occurrence_at",
  occurrences: "schedule_id,scheduled_at,schedule_revision,client_request_id,state,turn_id,attempts,created_at,updated_at",
};

const AGENDA_V3_TABLES:Record<string,string>={...AGENDA_TABLES,
  schedules:AGENDA_TABLES.schedules+",title,cron,time_zone",
  occurrences:AGENDA_TABLES.occurrences+",source",
  receipts:"client_request_id,request_hash,receipt_json,created_at",
};
export const SCHEMAS: Record<DatabaseKind, { userVersion: number; tables: Record<string, string> }> = {
  hub: { userVersion: 2, tables: HUB_TABLES },
  context: { userVersion: 0, tables: CONTEXT_TABLES },
  agenda: { userVersion: 2, tables: AGENDA_TABLES },
};

export interface Identity { ownerId: string; installationId: string }

export function openReadOnly(path: string): DatabaseSync {
  try { return new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: false, timeout: 0 }); }
  catch (error) { throw new OperationsError("corrupt", "database could not be opened read-only", { cause: error }); }
}

export const one = (db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row | undefined =>
  db.prepare(sql).get(...args) as Row | undefined;
export const all = (db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row[] =>
  db.prepare(sql).all(...args) as Row[];
export const count = (db: DatabaseSync, sql: string, ...args: Array<string | number | null>): number =>
  Number(one(db, sql, ...args)?.n ?? Number.NaN);

/** Exact table/column allowlist plus user_version and schema meta; triggers and views are refused. */
export function checkSchema(db: DatabaseSync, kind: DatabaseKind): Identity {
  try {
    const version = Number(one(db, "PRAGMA user_version")?.user_version);
    const contextVersion=kind==="context"?one(db,"SELECT value FROM meta WHERE key='schema'")?.value:undefined;
    if(kind==="context"&&(contextVersion==="3"||contextVersion==="4"||contextVersion==="5"))return checkFullSchema(db,"context");
    const expected=kind==="context"?{userVersion:0,tables:contextVersion==="2"?CONTEXT_V2_TABLES:one(db,"SELECT name FROM sqlite_master WHERE name='bot_documents'")?CONTEXT_DOCUMENT_TABLES:CONTEXT_TABLES}:kind==="agenda"&&version===3?{userVersion:3,tables:AGENDA_V3_TABLES}:SCHEMAS[kind];
    if (version !== expected.userVersion) fail("unsupported_schema", `${kind} database schema version is unsupported`);
    const objects = all(db, "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
    if (objects.some((row) => row.type !== "table" && row.type !== "index")) fail("unsupported_schema", `${kind} database has triggers or views`);
    const tables = objects.filter((row) => row.type === "table").map((row) => String(row.name)).sort();
    if (tables.join(",") !== Object.keys(expected.tables).sort().join(",")) fail("unsupported_schema", `${kind} database tables are unsupported`);
    for (const [table, columns] of Object.entries(expected.tables)) {
      const actual = all(db, `PRAGMA table_info(${JSON.stringify(table)})`).map((row) => String(row.name)).join(",");
      if (actual !== columns) fail("unsupported_schema", `${kind} database columns are unsupported`);
    }
    const meta = (key: string): string | undefined => {
      const value = one(db, "SELECT value FROM meta WHERE key = ?", key)?.value;
      return typeof value === "string" ? value : undefined;
    };
    let identity: { ownerId: string | undefined; installationId: string | undefined };
    if (kind === "hub") identity = { ownerId: meta("owner_id"), installationId: meta("host_id") };
    else if (kind === "context") {
      if (!["1","2"].includes(meta("schema")??"")) fail("unsupported_schema", "context schema is unsupported");
      identity = { ownerId: meta("owner"), installationId: meta("installation") };
    } else {
      if (meta("schema_version") !== String(version)) fail("unsupported_schema", "agenda schema is unsupported");
      identity = { ownerId: meta("owner_id"), installationId: meta("installation_id") };
    }
    if (!identity.ownerId || !identity.installationId) fail("identity_mismatch", `${kind} database has no owner or installation`);
    return identity as Identity;
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError("corrupt", `${kind} database could not be inspected`, { cause: error });
  }
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.ownerId === b.ownerId && a.installationId === b.installationId;
}

/** `integrity_check` and `foreign_key_check` on a staged, read-only copy. */
export function checkIntegrity(db: DatabaseSync, kind: string): void {
  try {
    const integrity = all(db, "PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") fail("corrupt", `${kind} database failed integrity_check`);
    if (all(db, "PRAGMA foreign_key_check").length) fail("reference_broken", `${kind} database failed foreign_key_check`);
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError("corrupt", `${kind} database failed integrity checks`, { cause: error });
  }
}
