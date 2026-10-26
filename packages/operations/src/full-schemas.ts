import {validateHub16Journals} from './hub-journals.js';
import {validateNativeMcpMetadata} from './mcp-journals.js';
import { MEMORY_BACKEND_SQL } from './memory-backend-schema.js';
import { MEMORY_LEARNING_SQL } from './memory-learning-schema.js';
import { validateGroups } from "./groups.js";
import { DatabaseSync } from "node:sqlite";
import { TEAM_WORKSPACES_META_KEY, MAX_TEAM_METADATA_BYTES, TeamWorkspacesMetadataSchema, teamWorkspacesCanonicalJSON, readMcpSetupDiagnostic, MEMORY_ROUTINE_META_KEY } from "@dexter/contracts";
import { NATIVE_MCP_RECEIPTS_SQL, MCP_INSTANCE_SELECTION_SQL, validateMcpInstanceSelectionSchema, validateMcpInstanceSelectionRows } from "@dexter/connectors";
import { OperationsError, fail } from "./errors.js";
import { EXACT_SCHEMAS, checkExactSchema, checkBotMetadata, checkDelegationMetadata, checkEngineSelectionMetadata, checkImageAttachmentMetadata, checkAvatarImageMetadata, checkToolActionMetadata, checkApprovalPolicyMetadata, checkExecutionAccessMetadata } from "./exact.js";
import { all, one, type Identity } from "./schemas.js";
import { readMemoryRoutineMetadata } from "./memory-routines.js";

/**
 * Exact catalogs for every store of the authority checkpoint format. The SQL is copied verbatim (extracted
 * mechanically, not retyped) from the reviewed sources: `@dexter/context` context.ts SCHEMA, `@dexter/agenda`
 * index.ts SCHEMA (fresh schema 2), `@dexter/devices` client-registry.ts TABLES (joined in order) and
 * `@dexter/relay-consumer` journal.ts SCHEMA; Hub v4, device registry v2 and device surface v2 come from
 * `exact.ts`. A store is accepted only when its whole `sqlite_schema` (type, name, table, normalized SQL,
 * autoindexes included) equals the catalog produced by executing that SQL in a private `:memory:` database, plus
 * the exact version marker and closed metadata. Unlike the inspection format, Context and Agenda are exact here:
 * an extra index, trigger, view, table, column or meta key fails closed.
 */
export type FullKind = "hub" | "context" | "agenda" | "deviceRegistry" | "deviceSurface" | "appClients" | "relayConsumer" | "relayAssociations" | "nativeMcp";

const CONTEXT_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE teams (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE members (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(team_id, owner_id));
CREATE TABLE team_bots (team_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY(team_id, bot_id));
CREATE TABLE recall_grants (bot_id TEXT NOT NULL, scope_key TEXT NOT NULL, allowed INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(bot_id, scope_key));
CREATE TABLE memories (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, locale TEXT NOT NULL, origin TEXT NOT NULL,
  active INTEGER NOT NULL, workspace TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, git_commit TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE promotions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_json TEXT NOT NULL, proposer_bot TEXT NOT NULL,
  request_hash TEXT NOT NULL, state TEXT NOT NULL, promoted_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE skills (id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, git_commit TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(id, version));
CREATE TABLE activations (scope_key TEXT NOT NULL, skill_id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY(scope_key, skill_id));
CREATE TABLE artifacts (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, head INTEGER NOT NULL, fork_id TEXT, fork_revision INTEGER);
CREATE TABLE revisions (artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, git_commit TEXT NOT NULL, path TEXT NOT NULL,
  origin TEXT NOT NULL, created_at INTEGER NOT NULL, restored_from INTEGER, PRIMARY KEY(artifact_id, revision));
`;
/** Context's identity-gated additive bot document migration; the original catalog remains accepted exactly. */
const CONTEXT_V1_DOCUMENTS = `${CONTEXT_V1}
CREATE TABLE IF NOT EXISTS bot_documents (bot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
          soul_pin_json TEXT NOT NULL, user_pin_json TEXT NOT NULL, memory_pin_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;
const CONTEXT_V2_DOCUMENTS = `${CONTEXT_V1_DOCUMENTS}
CREATE TABLE bot_document_revisions (bot_id TEXT NOT NULL, revision INTEGER NOT NULL,
  soul_pin_json TEXT NOT NULL, user_pin_json TEXT NOT NULL, memory_pin_json TEXT NOT NULL,
  memory_source_json TEXT NOT NULL, restored_from INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id, revision));
CREATE TABLE bot_document_receipts (bot_id TEXT NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  input_json TEXT NOT NULL, operation TEXT NOT NULL, origin_json TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(bot_id, operation_key));
`;
// Mechanically copied from context/src/memory-ledger.ts; exact admission belongs to this migration.
const CONTEXT_V3_LEDGER = CONTEXT_V2_DOCUMENTS + `
CREATE TABLE memory_subjects (bot_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE, mapper_version INTEGER NOT NULL CHECK(mapper_version > 0), created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER memory_subjects_immutable_update BEFORE UPDATE ON memory_subjects BEGIN SELECT RAISE(ABORT,'immutable memory identity'); END;
CREATE TRIGGER memory_subjects_immutable_delete BEFORE DELETE ON memory_subjects BEGIN SELECT RAISE(ABORT,'immutable memory identity'); END;
CREATE TABLE memory_scopes (scope_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch >= 0)) STRICT;
CREATE TABLE memory_records (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id),
  scope_key TEXT NOT NULL REFERENCES memory_scopes(scope_key), kind TEXT NOT NULL, head_revision INTEGER NOT NULL CHECK(head_revision > 0),
  state TEXT NOT NULL CHECK(state IN ('active','archived','expired','forgotten')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE memory_revisions (record_id TEXT NOT NULL REFERENCES memory_records(id), revision INTEGER NOT NULL CHECK(revision > 0),
  content TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64), evidence_json TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL CHECK(policy_epoch >= 0), valid_from INTEGER, valid_until INTEGER, supersedes INTEGER,
  operation_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY(record_id,revision)) STRICT;
CREATE TRIGGER memory_revisions_immutable_update BEFORE UPDATE ON memory_revisions BEGIN SELECT RAISE(ABORT,'immutable memory revision'); END;
CREATE TRIGGER memory_revisions_immutable_delete BEFORE DELETE ON memory_revisions BEGIN SELECT RAISE(ABORT,'immutable memory revision'); END;
CREATE TABLE memory_candidates (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), scope_key TEXT NOT NULL,
  record_id TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, evidence_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0), policy_epoch INTEGER NOT NULL CHECK(policy_epoch >= 0),
  extractor_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','withdrawn')),
  operation_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE memory_jobs (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), scope_key TEXT NOT NULL,
  record_id TEXT NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL, evidence_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0), policy_epoch INTEGER NOT NULL CHECK(policy_epoch >= 0),
  config_version TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','committed','unknown','conflict','withdrawn')),
  lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL CHECK(fence >= 0), attempts INTEGER NOT NULL CHECK(attempts >= 0),
  committed_operation_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE memory_ledger_operations (operation_key TEXT PRIMARY KEY, kind TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_json TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER memory_ledger_operations_immutable_update BEFORE UPDATE ON memory_ledger_operations BEGIN SELECT RAISE(ABORT,'immutable memory operation'); END;
CREATE TRIGGER memory_ledger_operations_immutable_delete BEFORE DELETE ON memory_ledger_operations BEGIN SELECT RAISE(ABORT,'immutable memory operation'); END;
CREATE TABLE memory_projection_outbox (operation_key TEXT PRIMARY KEY, revision_operation_key TEXT NOT NULL,
  record_id TEXT NOT NULL, revision INTEGER NOT NULL, scope_key TEXT NOT NULL, policy_epoch INTEGER NOT NULL,
  account_id TEXT NOT NULL, user_id TEXT NOT NULL, uri TEXT NOT NULL, content_hash TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','delete')),
  state TEXT NOT NULL CHECK(state IN ('queued','dispatched','confirmed','unknown','conflict','withdrawn')),
  lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL CHECK(fence >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY(record_id,revision) REFERENCES memory_revisions(record_id,revision), UNIQUE(uri,operation)) STRICT;
CREATE TABLE memory_projection_receipts (operation_key TEXT NOT NULL REFERENCES memory_projection_outbox(operation_key),
  fence INTEGER NOT NULL CHECK(fence > 0), binding_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','unknown','conflict')), indexing TEXT NOT NULL CHECK(indexing='unproven'),
  task_id TEXT, reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(operation_key,fence)) STRICT;
CREATE TRIGGER memory_projection_receipts_immutable_update BEFORE UPDATE ON memory_projection_receipts BEGIN SELECT RAISE(ABORT,'immutable projection receipt'); END;
CREATE TRIGGER memory_projection_receipts_immutable_delete BEFORE DELETE ON memory_projection_receipts BEGIN SELECT RAISE(ABORT,'immutable projection receipt'); END;
CREATE TABLE memory_tombstones (record_id TEXT PRIMARY KEY REFERENCES memory_records(id), scope_key TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0), evidence_json TEXT NOT NULL, hashes_json TEXT NOT NULL,
  suppression_signature TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER memory_tombstones_immutable_update BEFORE UPDATE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory suppression'); END;
CREATE TRIGGER memory_tombstones_immutable_delete BEFORE DELETE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory suppression'); END;
CREATE INDEX memory_jobs_claim ON memory_jobs(state,lease_until,id);
CREATE INDEX memory_projection_pending ON memory_projection_outbox(state,operation,record_id,revision);
`;
const AGENDA_V2 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('once', 'interval')),
  at INTEGER,
  interval_ms INTEGER,
  next_at INTEGER,
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'completed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_occurrence_at INTEGER,
  CHECK ((kind = 'once' AND at IS NOT NULL AND interval_ms IS NULL) OR
         (kind = 'interval' AND at IS NULL AND interval_ms IS NOT NULL))
) STRICT;
CREATE INDEX schedules_due ON schedules (state, next_at, id);
CREATE INDEX schedules_page ON schedules (created_at, id);
CREATE TABLE occurrences (
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  scheduled_at INTEGER NOT NULL,
  schedule_revision INTEGER NOT NULL CHECK (schedule_revision > 0),
  client_request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'withdrawn', 'blocked')),
  turn_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (schedule_id, scheduled_at),
  CHECK ((state = 'accepted' AND turn_id IS NOT NULL) OR state <> 'accepted')
) STRICT;
CREATE INDEX occurrences_pending ON occurrences (state, attempts, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_terminal ON occurrences (state, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_schedule_state ON occurrences (schedule_id, state);
`;
const AGENDA_V3 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('once', 'interval', 'cron')),
  at INTEGER,
  interval_ms INTEGER,
  next_at INTEGER,
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'completed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_occurrence_at INTEGER,
  title TEXT NOT NULL,
  cron TEXT,
  time_zone TEXT,
  CHECK ((kind = 'once' AND at IS NOT NULL AND interval_ms IS NULL) OR
         (kind = 'interval' AND at IS NULL AND interval_ms IS NOT NULL) OR
         (kind = 'cron' AND at IS NULL AND interval_ms IS NULL AND cron IS NOT NULL AND time_zone IS NOT NULL))
) STRICT;
CREATE INDEX schedules_due ON schedules (state, next_at, id);
CREATE INDEX schedules_page ON schedules (created_at, id);
CREATE TABLE occurrences (
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  scheduled_at INTEGER NOT NULL,
  schedule_revision INTEGER NOT NULL CHECK (schedule_revision > 0),
  client_request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'withdrawn', 'blocked')),
  turn_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'scheduled' CHECK (source IN ('scheduled','manual')),
  PRIMARY KEY (schedule_id, scheduled_at),
  CHECK ((state = 'accepted' AND turn_id IS NOT NULL) OR state <> 'accepted')
) STRICT;
CREATE INDEX occurrences_pending ON occurrences (state, attempts, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_terminal ON occurrences (state, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_schedule_state ON occurrences (schedule_id, state);
CREATE TABLE receipts (
  client_request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`;
const APP_CLIENTS_V1 = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE offers (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL, device_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'cancelled', 'exhausted')), attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE claims (
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL UNIQUE REFERENCES offers(id), kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL, client_fp TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'rejected', 'failed')),
  device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
) STRICT;
CREATE TABLE client_certs (
  fp TEXT PRIMARY KEY, device_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'revoked')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX client_certs_active ON client_certs (device_id) WHERE state = 'active';
CREATE TABLE client_bindings (
  device_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL, enrollment_digest TEXT NOT NULL,
  fp TEXT NOT NULL UNIQUE REFERENCES client_certs(fp),
  generation INTEGER NOT NULL CHECK (generation >= 1), revision INTEGER NOT NULL CHECK (revision >= generation),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
) STRICT;`;
/**
 * `@dexter/relay-host` associations.ts SQL (frozen public interface, Sol relay-host R1, file sha256
 * 4d38ddc4ee9b5eddcd819f1fe28bacfee44ca2c7cf36f050392fb8c32d77a273), extracted mechanically. Adopted by this
 * candidate only; it stays unsupported in every historical format until this adoption is reviewed.
 */
const RELAY_ASSOCIATIONS_V1 = `CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),host_id TEXT NOT NULL,owner_id TEXT NOT NULL,host_revision INTEGER NOT NULL,recipient_json TEXT NOT NULL);
CREATE TABLE associations(device_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','revoked')),binding_json TEXT NOT NULL,sender_json TEXT NOT NULL,host_revision INTEGER NOT NULL);
CREATE TABLE history(device_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL CHECK(action IN ('enroll','revoke','recipient')),binding_json TEXT NOT NULL,sender_json TEXT NOT NULL,host_revision INTEGER NOT NULL,PRIMARY KEY(device_id,revision));
CREATE TABLE pins(device_id TEXT NOT NULL,generation INTEGER NOT NULL,key_id TEXT NOT NULL UNIQUE,signing_key TEXT NOT NULL UNIQUE,encryption_key TEXT NOT NULL UNIQUE,pin_json TEXT NOT NULL,PRIMARY KEY(device_id,generation));`;
const RELAY_CONSUMER_V1 = `CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),host_id TEXT NOT NULL,owner_id TEXT NOT NULL);
CREATE TABLE operations(device_id TEXT NOT NULL,operation_id TEXT NOT NULL,logical_hash TEXT NOT NULL CHECK(length(logical_hash)=64),thread_id TEXT,request_id TEXT NOT NULL,issuer_hash TEXT NOT NULL CHECK(length(issuer_hash)=64),state TEXT NOT NULL CHECK(state IN ('prepared','committed','acked','blocked','unknown')),turn_id TEXT,PRIMARY KEY(device_id,operation_id));
CREATE TABLE issuers(hash TEXT PRIMARY KEY CHECK(length(hash)=64),provenance_json TEXT NOT NULL);
CREATE TABLE acknowledgements(device_id TEXT NOT NULL,operation_id TEXT NOT NULL,message_id TEXT NOT NULL,receipt_id TEXT NOT NULL,issuer_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','acked')),request_json TEXT,PRIMARY KEY(message_id,receipt_id),FOREIGN KEY(device_id,operation_id) REFERENCES operations(device_id,operation_id));
CREATE INDEX operation_states ON operations(state,device_id,operation_id);`;

const NATIVE_MCP_V1 = `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE servers(id TEXT PRIMARY KEY, definition TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('configured','ready','failed','needs_auth','deleting'))) STRICT;
          CREATE TABLE catalogs(server_id TEXT PRIMARY KEY, tools TEXT NOT NULL) STRICT;
          CREATE TABLE connections(server_id TEXT NOT NULL, profile_id TEXT NOT NULL, connection_id TEXT NOT NULL,
            PRIMARY KEY(server_id, profile_id)) STRICT;
          CREATE TABLE selections(server_id TEXT NOT NULL, bot_id TEXT NOT NULL, tools TEXT NOT NULL,
            PRIMARY KEY(server_id, bot_id)) STRICT;`;

const NATIVE_MCP_V2 = NATIVE_MCP_V1 + NATIVE_MCP_RECEIPTS_SQL;

interface FullSchema {
  readonly sql: string;
  readonly userVersion: number;
  /** Closed key/value metadata (`meta` table), or the single-row `metadata` table of the relay consumer journal. */
  readonly identity:
    | { readonly kind: "meta"; readonly keys: readonly string[]; readonly owner: string; readonly installation: string; readonly marker: readonly [string, string] | null }
    | { readonly kind: "metadata" } | { readonly kind: "associationsMetadata" };
  readonly label: string;
}
const hubMeta = { kind: "meta", keys: ["host_id", "owner_id"], owner: "owner_id", installation: "host_id", marker: null } as const;
export const FULL_SCHEMAS: Readonly<Record<FullKind, FullSchema>> = Object.freeze({
  nativeMcp: { sql: NATIVE_MCP_V2, userVersion: 0, label: "native-mcp-v2",
    identity: { kind: "meta", keys: ["installation", "owner", "schema"], owner: "owner", installation: "installation", marker: ["schema", "2"] } },
  // exact.ts reaches this module through schemas.ts. Defer only these catalog reads
  // until module initialization has completed; schema bytes and validation stay exact.
  hub: { get sql() { return EXACT_SCHEMAS.hub16.sql; }, userVersion: 16, identity: hubMeta, label: "hub-v16" },
  context: {
    sql: CONTEXT_V3_LEDGER+MEMORY_LEARNING_SQL+MEMORY_BACKEND_SQL, userVersion: 0, label: "context-v5-memory-learning-backend",
    identity: { kind: "meta", keys: ["installation", "owner", "schema"], owner: "owner", installation: "installation", marker: ["schema", "5"] },
  },
  agenda: {
    sql: AGENDA_V3, userVersion: 3, label: "agenda-v3",
    identity: { kind: "meta", keys: ["installation_id", "owner_id", "schema_version"], owner: "owner_id", installation: "installation_id", marker: ["schema_version", "3"] },
  },
  deviceRegistry: {
    get sql() { return EXACT_SCHEMAS.deviceRegistry.sql; }, userVersion: 0, label: "device-registry-v2",
    identity: { kind: "meta", keys: ["installation_id", "owner_id", "schema_version"], owner: "owner_id", installation: "installation_id", marker: ["schema_version", "2"] },
  },
  deviceSurface: {
    get sql() { return EXACT_SCHEMAS.deviceSurface.sql; }, userVersion: 0, label: "device-surface-v3",
    identity: { kind: "meta", keys: ["installation", "owner", "schema"], owner: "owner", installation: "installation", marker: ["schema", "3"] },
  },
  appClients: {
    sql: APP_CLIENTS_V1, userVersion: 0, label: "app-clients-v1",
    identity: { kind: "meta", keys: ["installation_id", "namespace", "owner_id", "schema_version"], owner: "owner_id", installation: "installation_id", marker: ["schema_version", "1"] },
  },
  relayConsumer: { sql: RELAY_CONSUMER_V1, userVersion: 0, label: "relay-consumer-v1", identity: { kind: "metadata" } },
  relayAssociations: { sql: RELAY_ASSOCIATIONS_V1, userVersion: 0, label: "relay-associations-v1", identity: { kind: "associationsMetadata" } },
});

const normalize = (sql: unknown): string | null => (typeof sql === "string" ? sql.replace(/\s+/g, " ").trim().replace(/;$/, "") : null);
function catalogOf(db: DatabaseSync): string {
  return all(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .map((row) => JSON.stringify([row.type, row.name, row.tbl_name, normalize(row.sql)])).join("\n");
}
const references = new Map<FullKind, string>();
export function fullReferenceCatalog(kind: FullKind): string {
  let cached = references.get(kind);
  if (cached === undefined) {
    const db = new DatabaseSync(":memory:");
    try { db.exec(FULL_SCHEMAS[kind].sql); cached = catalogOf(db); } finally { db.close(); }
    references.set(kind, cached);
  }
  return cached;
}

let historicalContextCatalog: string | undefined;
let historicalDocumentsCatalog: string | undefined;
let historicalV3Catalog:string|undefined;
let historicalV4Catalog:string|undefined;
let historicalV2Catalog: string | undefined;
export type ContextSchemaLabel = 'context-v1' | 'context-v1-bot-documents' | 'context-v2-document-history' | 'context-v2-document-history-memory-routines-v1' | 'context-v3-memory-ledger' | 'context-v3-memory-ledger-memory-routines-v1' | 'context-v4-memory-learning' | 'context-v4-memory-learning-memory-routines-v1' | 'context-v5-memory-learning-backend' | 'context-v5-memory-learning-backend-memory-routines-v1';
/** Marker and exact SQL agree; no missing trigger, partial ledger or arbitrary extension is admitted. */
export function contextSchemaLabel(db: DatabaseSync): ContextSchemaLabel {
  const catalog=catalogOf(db),marker=one(db,"SELECT value FROM meta WHERE key='schema'")?.value,routines=readMemoryRoutineMetadata(db)!==null;
  if(marker==='5'&&catalog===fullReferenceCatalog('context'))return routines?'context-v5-memory-learning-backend-memory-routines-v1':'context-v5-memory-learning-backend';
  if(historicalV4Catalog===undefined){const historical=new DatabaseSync(':memory:');try{historical.exec(CONTEXT_V3_LEDGER+MEMORY_LEARNING_SQL);historicalV4Catalog=catalogOf(historical);}finally{historical.close();}}
  if(marker==='4'&&catalog===historicalV4Catalog)return routines?'context-v4-memory-learning-memory-routines-v1':'context-v4-memory-learning';
  if(historicalV3Catalog===undefined){const historical=new DatabaseSync(':memory:');try{historical.exec(CONTEXT_V3_LEDGER);historicalV3Catalog=catalogOf(historical);}finally{historical.close();}}
  if(marker==='3'&&catalog===historicalV3Catalog)return routines?'context-v3-memory-ledger-memory-routines-v1':'context-v3-memory-ledger';
  if(historicalV2Catalog===undefined){const historical=new DatabaseSync(':memory:');try{historical.exec(CONTEXT_V2_DOCUMENTS);historicalV2Catalog=catalogOf(historical);}finally{historical.close();}}
  if(marker==='2'&&catalog===historicalV2Catalog)return routines?'context-v2-document-history-memory-routines-v1':'context-v2-document-history';
  if(historicalDocumentsCatalog===undefined){const historical=new DatabaseSync(':memory:');try{historical.exec(CONTEXT_V1_DOCUMENTS);historicalDocumentsCatalog=catalogOf(historical);}finally{historical.close();}}
  if(marker==='1'&&catalog===historicalDocumentsCatalog)return 'context-v1-bot-documents';
  if(historicalContextCatalog===undefined){const historical=new DatabaseSync(':memory:');try{historical.exec(CONTEXT_V1);historicalContextCatalog=catalogOf(historical);}finally{historical.close();}}
  if(marker==='1'&&catalog===historicalContextCatalog)return 'context-v1';
  return fail('unsupported_schema','context marker/catalog is not the reviewed exact schema');
}

let historicalAgendaCatalog:string|undefined;
/** Preserve the exact historical Agenda v2 catalog while intentionally accepting v3. */
export function agendaSchemaLabel(db:DatabaseSync):"agenda-v2"|"agenda-v3" {
  const version=Number(one(db,"PRAGMA user_version")?.user_version),catalog=catalogOf(db);
  if(version===3&&catalog===fullReferenceCatalog("agenda"))return "agenda-v3";
  if(historicalAgendaCatalog===undefined){const historical=new DatabaseSync(":memory:");try{historical.exec(AGENDA_V2);historicalAgendaCatalog=catalogOf(historical);}finally{historical.close();}}
  if(version===2&&catalog===historicalAgendaCatalog)return "agenda-v2";
  return fail("unsupported_schema","agenda schema is not an accepted exact schema");
}
let historicalNativeMcpCatalog: string | undefined;
let instanceNativeMcpCatalog: string | undefined;
/** Marker and exact SQL must agree; old snapshots remain v1, never silently relabeled or upgraded by validation. */
export function nativeMcpSchemaLabel(db: DatabaseSync): "native-mcp-v1" | "native-mcp-v2" | "native-mcp-v3" {
  const marker = one(db, "SELECT value FROM meta WHERE key='schema'")?.value;
  if (Number(one(db, "PRAGMA user_version")?.user_version) !== 0) fail("unsupported_schema", "native MCP user_version is unsupported");
  const catalog = catalogOf(db);
  if (marker === "2" && catalog === fullReferenceCatalog("nativeMcp")) return "native-mcp-v2";
  if (instanceNativeMcpCatalog === undefined) {
    const reference = new DatabaseSync(":memory:");
    try { reference.exec(NATIVE_MCP_V2 + MCP_INSTANCE_SELECTION_SQL); instanceNativeMcpCatalog = catalogOf(reference); } finally { reference.close(); }
  }
  if (marker === "3" && catalog === instanceNativeMcpCatalog) {
    validateMcpInstanceSelectionSchema(db); validateMcpInstanceSelectionRows(db); return "native-mcp-v3";
  }
  if (historicalNativeMcpCatalog === undefined) {
    const historical = new DatabaseSync(":memory:");
    try { historical.exec(NATIVE_MCP_V1); historicalNativeMcpCatalog = catalogOf(historical); } finally { historical.close(); }
  }
  if (marker === "1" && catalog === historicalNativeMcpCatalog) return "native-mcp-v1";
  return fail("unsupported_schema", "native MCP marker/catalog is not an accepted exact schema");
}
export function deviceSurfaceSchemaLabel(db: DatabaseSync): "device-surface-v2" | "device-surface-v3" {
  checkExactSchema(db,"deviceSurface");
  return one(db,"SELECT value FROM meta WHERE key='schema'")?.value === "2" ? "device-surface-v2" : "device-surface-v3";
}
/** Exact catalog, version and closed metadata; returns the recorded identity. */
export function checkFullSchema(db: DatabaseSync, kind: FullKind): Identity {
  try {
    if (kind === "deviceSurface") return checkExactSchema(db, "deviceSurface");
    if (kind === "hub") {
      const version = Number(one(db, "PRAGMA user_version")?.user_version);
      const identity = checkExactSchema(db, version === 4 ? "hub4" : version === 5 ? "hub5" : version === 6 ? "hub6" : version === 7 ? "hub7" : version === 8 ? "hub8" : version === 9 ? "hub9" : version === 10 ? "hub10" : version === 11 ? "hub11" : version === 12 ? "hub12" : version === 13 ? "hub13" : version===16 ? "hub16" : version===15 ? "hub15" : "hub14");
      if (version >= 5) checkBotMetadata(db);
      if (version >= 6) checkDelegationMetadata(db);
      if (version >= 7) checkEngineSelectionMetadata(db);
      if (version >= 8) checkImageAttachmentMetadata(db);
      if (version >= 10) checkAvatarImageMetadata(db);
      if (version >= 11) checkToolActionMetadata(db);
      if (version >= 12) checkApprovalPolicyMetadata(db);
      if (version >= 13) checkExecutionAccessMetadata(db);
      if (version >= 15) validateGroups(db,identity.installationId);
      if(version===16)validateHub16Journals(db);
      return identity;
    }
    const baseSchema=FULL_SCHEMAS[kind];
    const historicalAgenda=kind==="agenda"&&agendaSchemaLabel(db)==="agenda-v2";
    const historicalContext=kind==="context"&&["context-v1","context-v1-bot-documents"].includes(contextSchemaLabel(db));
    const v2Context=kind==="context"&&contextSchemaLabel(db).startsWith("context-v2-");
    const historicalNativeMcp=kind==="nativeMcp"&&nativeMcpSchemaLabel(db)==="native-mcp-v1";
    const instanceNativeMcp=kind==="nativeMcp"&&nativeMcpSchemaLabel(db)==="native-mcp-v3";
    const v3Context=kind==="context"&&contextSchemaLabel(db).startsWith("context-v3-");
    const v4Context=kind==="context"&&contextSchemaLabel(db).startsWith("context-v4-");
    const schema=v4Context?{...baseSchema,identity:{kind:"meta" as const,keys:["installation","owner","schema"],owner:"owner",installation:"installation",marker:["schema","4"] as const}}:v3Context?{...baseSchema,identity:{kind:"meta" as const,keys:["installation","owner","schema"],owner:"owner",installation:"installation",marker:["schema","3"] as const}}:v2Context?{...baseSchema,identity:{kind:"meta" as const,keys:["installation","owner","schema"],owner:"owner",installation:"installation",marker:["schema","2"] as const}}:instanceNativeMcp?{...baseSchema,identity:{kind:"meta" as const,keys:["installation","owner","schema"],owner:"owner",installation:"installation",marker:["schema","3"] as const}}:historicalNativeMcp?{...baseSchema,identity:{kind:"meta" as const,keys:["installation","owner","schema"],owner:"owner",installation:"installation",marker:["schema","1"] as const}}:historicalContext?{...baseSchema,identity:{kind:"meta" as const,keys:["installation","owner","schema"],owner:"owner",installation:"installation",marker:["schema","1"] as const}}:historicalAgenda?{...baseSchema,userVersion:2,identity:{kind:"meta" as const,keys:["installation_id","owner_id","schema_version"],owner:"owner_id",installation:"installation_id",marker:["schema_version","2"] as const}}:baseSchema;
    if (Number(one(db, "PRAGMA user_version")?.user_version) !== schema.userVersion) fail("unsupported_schema", `${kind} schema version is unsupported`);
    if(kind==="context")contextSchemaLabel(db);
    else if (kind!=="agenda" && kind!=="nativeMcp" && catalogOf(db) !== fullReferenceCatalog(kind)) fail("unsupported_schema", `${kind} schema is not the reviewed exact schema`);
    let ownerId: unknown; let installationId: unknown;
    if (schema.identity.kind === "associationsMetadata") {
      const rows = all(db, "SELECT * FROM metadata");
      if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.version !== 1) fail("unsupported_schema", `${kind} metadata is not the reviewed set`);
      ownerId = rows[0]!.owner_id; installationId = rows[0]!.host_id;
    } else if (schema.identity.kind === "metadata") {
      const rows = all(db, "SELECT * FROM metadata");
      if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.schema_version !== 1) fail("unsupported_schema", `${kind} metadata is not the reviewed set`);
      ownerId = rows[0]!.owner_id; installationId = rows[0]!.host_id;
    } else {
      const meta = new Map(all(db, "SELECT key, value FROM meta").map((row) => [String(row.key), row.value]));
      const expectedKeys = [...schema.identity.keys];
      if (kind === "nativeMcp") {
        // D04 uses the existing meta container, not a SQL migration/version alias. Accept only exact
        // registered-instance keys and closed value-free diagnostics; arbitrary additional metadata still fails.
        const servers = new Map(all(db,"SELECT id,status FROM servers").map(row=>[String(row.id),String(row.status)]));
        if (servers.size > 256 || meta.size > 3+256*5+512) fail("corrupt", "native MCP setup metadata exceeds its bound");
        expectedKeys.push(...validateNativeMcpMetadata(db));
        for (const [key,value] of meta) {
          const match = /^(mcp-instance|mcp-diagnostic):([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)$/.exec(key);
          if (!match) continue;
          const status = servers.get(match[2]!);
          if (!status || typeof value !== "string") fail("reference_broken", "native MCP setup metadata has no registered instance");
          if (match[1] === "mcp-instance") {
            if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)) fail("corrupt", "native MCP instance generation is invalid");
          } else {
            if (!["failed","needs_auth"].includes(status) || value.length > 1024) fail("corrupt", "native MCP diagnostic state is invalid");
            let decoded: unknown; try { decoded = JSON.parse(value); } catch { fail("corrupt", "native MCP diagnostic is invalid"); }
            const fixed = readMcpSetupDiagnostic(decoded);
            if (!fixed || JSON.stringify(fixed) !== value) fail("corrupt", "native MCP diagnostic is not canonical");
          }
          expectedKeys.push(key);
        }
      }
      if (kind === "context" && meta.has(TEAM_WORKSPACES_META_KEY)) {
        expectedKeys.push(TEAM_WORKSPACES_META_KEY);
        const raw = meta.get(TEAM_WORKSPACES_META_KEY);
        if (typeof raw !== "string" || Buffer.byteLength(raw,"utf8") > MAX_TEAM_METADATA_BYTES) fail("corrupt", "context team metadata is invalid");
        let value: unknown;
        try { value = JSON.parse(raw); } catch { fail("corrupt", "context team metadata is invalid"); }
        const parsed = TeamWorkspacesMetadataSchema.safeParse(value);
        if (!parsed.success || teamWorkspacesCanonicalJSON(parsed.data) !== raw) fail("corrupt", "context team metadata is not canonical");
      }
      if (kind === "context" && meta.has(MEMORY_ROUTINE_META_KEY)) {
        readMemoryRoutineMetadata(db);
        expectedKeys.push(MEMORY_ROUTINE_META_KEY);
      }
      if ([...meta.keys()].sort().join(",") !== expectedKeys.sort().join(",")) fail("unsupported_schema", `${kind} meta is not the reviewed set`);
      if (schema.identity.marker && meta.get(schema.identity.marker[0]) !== schema.identity.marker[1]) fail("unsupported_schema", `${kind} schema marker is unsupported`);
      if (kind === "appClients" && meta.get("namespace") !== "app-client-v1") fail("unsupported_schema", "appClients namespace is unsupported");
      ownerId = meta.get(schema.identity.owner); installationId = meta.get(schema.identity.installation);
    }
    if (typeof ownerId !== "string" || !ownerId || typeof installationId !== "string" || !installationId) fail("identity_mismatch", `${kind} has no owner or installation`);
    return { ownerId, installationId };
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError("corrupt", `${kind} database could not be inspected`, { cause: error });
  }
}
