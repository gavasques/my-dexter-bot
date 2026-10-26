import { BotSchema, BotDelegationSchema, EngineSelectionSchema, ToolRequestSchema, type EngineSelection,
  LIVE_VOICE_META_KEY,LiveVoiceConfigurationSchema,liveVoiceConfigurationJSON,
  BROWSER_USE_META_KEY,MAX_BROWSER_USE_METADATA_BYTES,BrowserUseConfigurationSchema,browserUseConfigurationJSON,
  AvatarImageSchema,AvatarImageIdSchema,MAX_AVATAR_STORAGE_BYTES,MAX_AVATAR_IMAGES,MAX_AVATAR_UPLOAD_RECEIPTS,
  ActionAuthorizationSchema,BotApprovalPolicySchema,BotApprovalPolicyReceiptSchema, type BotApprovalPolicyReceipt } from "@dexter/contracts";
import { assertApprovalPreferencesData, assertBotExecutionAccessData, validatePng, canonicalJson } from "@dexter/hub";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { OperationsError, fail } from "./errors.js";
import { all, one, type Identity } from "./schemas.js";

/**
 * Exact schema catalogs for the version 2 artifact. The SQL below is copied verbatim from the reviewed, frozen
 * sources (`@dexter/hub` store.ts SCHEMA_V1..V3 with TURN_STATES/TURN_EVENT_KINDS interpolated,
 * `@dexter/devices` registry.ts SCHEMA+BINDINGS, `@dexter/cli` device-turn-surface.ts SCHEMA). A staged copy is
 * accepted only when every `sqlite_schema` row (type, name, table and whitespace-normalized SQL, autoindexes and
 * `sqlite_sequence` included) equals the reference produced by executing this SQL in a private `:memory:`
 * database, plus the exact version marker and closed meta keys. Any other table, column, CHECK, FK, index,
 * trigger or view — including an imported trigger on an otherwise canonical table — fails closed. A schema
 * change in those packages must update this file deliberately; the tests compare it against the real stores.
 */
export type ExactKind = "hub" | "hub4" | "hub5" | "hub6" | "hub7" | "hub8" | "hub9" | "hub10" | "hub11" | "hub12" | "hub13" | "hub14" | "deviceRegistry" | "deviceSurface";

const HUB_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE host_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1), hostname TEXT NOT NULL, pid INTEGER NOT NULL,
  token TEXT NOT NULL, acquired_at INTEGER NOT NULL
) STRICT;
CREATE TABLE profiles (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE bots (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE threads (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE messages (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id),
  client_message_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (thread_id, client_message_id)
) STRICT;
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  bot_id TEXT, thread_id TEXT, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE grants (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), tool TEXT NOT NULL, destination TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('allow', 'ask', 'deny')), expires_at INTEGER,
  revision INTEGER NOT NULL CHECK (revision > 0), updated_at INTEGER NOT NULL, UNIQUE (bot_id, tool, destination)
) STRICT;
CREATE TABLE devices (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('macos', 'ios')),
  capabilities TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE TABLE actions (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), thread_id TEXT NOT NULL REFERENCES threads(id),
  tool TEXT NOT NULL, destination TEXT NOT NULL, idempotency_key TEXT NOT NULL, request TEXT NOT NULL,
  request_hash TEXT NOT NULL, grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'ready', 'running', 'succeeded', 'denied', 'blocked', 'unknown')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, approval_expires_at INTEGER, decided_by TEXT, result TEXT,
  reason TEXT CHECK (reason IS NULL OR reason IN ('user_denied', 'approval_expired', 'permission_changed', 'host_interrupted', 'executor_error')),
  UNIQUE (bot_id, idempotency_key)
) STRICT;
CREATE INDEX actions_by_target ON actions (bot_id, tool, destination, state);
CREATE INDEX actions_by_state ON actions (state);
CREATE INDEX threads_by_bot ON threads (bot_id);
`;
const HUB_V2 = `
CREATE TABLE thread_sessions (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')),
  native_cursor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE turns (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id),
  bot_id TEXT NOT NULL REFERENCES bots(id), engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')),
  client_request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  input_message_id TEXT NOT NULL REFERENCES messages(id), output_message_id TEXT REFERENCES messages(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'interrupted', 'failed', 'unknown')), code TEXT,
  output_chars INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL,
  UNIQUE (thread_id, client_request_id)
) STRICT;
CREATE INDEX turns_by_thread ON turns (thread_id, cursor);
CREATE INDEX turns_by_state ON turns (state);
CREATE TABLE turn_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES turns(id), thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn.queued', 'turn.started', 'text.delta', 'tool.requested', 'tool.resolved', 'turn.completed', 'turn.interrupted', 'turn.failed', 'turn.unknown')), text TEXT, data TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX turn_events_by_turn ON turn_events (turn_id, cursor);
CREATE INDEX turn_events_by_thread ON turn_events (thread_id, cursor);
`;
const HUB_V3 = `CREATE TABLE client_device_enrollments (
  namespace TEXT NOT NULL CHECK (namespace = 'app-client-v1'), claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 128),
  host_key TEXT NOT NULL DEFAULT 'host_id' CHECK (host_key = 'host_id') REFERENCES meta(key),
  owner_key TEXT NOT NULL DEFAULT 'owner_id' CHECK (owner_key = 'owner_id') REFERENCES meta(key),
  host_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(id),
  original_name TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0), PRIMARY KEY (namespace, claim_id)
) STRICT;CREATE TRIGGER client_enrollment_no_update BEFORE UPDATE ON client_device_enrollments
BEGIN SELECT RAISE(ABORT, 'client enrollment is immutable'); END;CREATE TRIGGER client_enrollment_no_delete BEFORE DELETE ON client_device_enrollments
BEGIN SELECT RAISE(ABORT, 'client enrollment is immutable'); END;`;

/** Hub schema 4 (`SCHEMA_V4`): persisted host authority plus its three triggers. */
const HUB_V4 = `CREATE TABLE host_authority (
  id INTEGER PRIMARY KEY CHECK (id = 1), installation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 1), state TEXT NOT NULL CHECK (state IN ('active', 'checkpointed', 'revoked')),
  directory TEXT NOT NULL, directory_ino TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('genesis', 'legacy_upgrade', 'activation')),
  activation_receipt TEXT CHECK (activation_receipt IS NULL OR (length(activation_receipt) = 64 AND activation_receipt NOT GLOB '*[^0-9a-f]*')),
  checkpoint_id TEXT, revoked_artifact TEXT, revoked_target TEXT, updated_at INTEGER NOT NULL,
  CHECK ((state = 'active') = (checkpoint_id IS NULL)), CHECK ((state = 'revoked') = (revoked_artifact IS NOT NULL))
) STRICT;CREATE TRIGGER host_authority_no_delete BEFORE DELETE ON host_authority
BEGIN SELECT RAISE(ABORT, 'host authority is permanent'); END;CREATE TRIGGER host_authority_revoked_final BEFORE UPDATE ON host_authority WHEN OLD.state = 'revoked'
BEGIN SELECT RAISE(ABORT, 'revoked host authority is final'); END;CREATE TRIGGER host_authority_forward BEFORE UPDATE ON host_authority
WHEN NEW.epoch < OLD.epoch OR NEW.installation_id != OLD.installation_id OR NEW.owner_id != OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'host authority only moves forward'); END;`;

const HUB_V5 = `
ALTER TABLE bots ADD COLUMN role_description TEXT NOT NULL DEFAULT '' CHECK (length(role_description) <= 2000);
ALTER TABLE bots ADD COLUMN avatar_emoji TEXT CHECK (avatar_emoji IS NULL OR length(avatar_emoji) <= 16);
ALTER TABLE bots ADD COLUMN can_see_bots INTEGER NOT NULL DEFAULT 0 CHECK (can_see_bots IN (0,1));
ALTER TABLE bots ADD COLUMN can_receive_orders INTEGER NOT NULL DEFAULT 0 CHECK (can_receive_orders IN (0,1));
ALTER TABLE bots ADD COLUMN can_send_actions INTEGER NOT NULL DEFAULT 0 CHECK (can_send_actions IN (0,1));
ALTER TABLE bots ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0,1));
ALTER TABLE bots ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE UNIQUE INDEX bots_one_master_per_owner ON bots(owner_id) WHERE is_master = 1;
`;

const HUB_V6 = `
CREATE TABLE bot_delegations (
  id TEXT PRIMARY KEY, source_bot_id TEXT NOT NULL REFERENCES bots(id), target_bot_id TEXT NOT NULL REFERENCES bots(id),
  source_thread_id TEXT NOT NULL REFERENCES threads(id), target_thread_id TEXT NOT NULL REFERENCES threads(id),
  source_turn_id TEXT NOT NULL REFERENCES turns(id), target_turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
  parent_id TEXT REFERENCES bot_delegations(id), root_id TEXT NOT NULL REFERENCES turns(id),
  depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 3), deadline_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','completed','cancelled','failed','unknown')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result TEXT CHECK (result IS NULL OR length(result) <= 32768),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64), call_id TEXT NOT NULL,
  UNIQUE(source_turn_id, call_id)
) STRICT;
CREATE INDEX bot_delegations_root ON bot_delegations(root_id, state);
`;

/** Hub SCHEMA_V7, including the data migration; historical catalogs stay unchanged. */
const HUB_V7 = `
ALTER TABLE bots ADD COLUMN default_selection TEXT;
ALTER TABLE turns ADD COLUMN selection TEXT;
ALTER TABLE turns ADD COLUMN handoff TEXT;
CREATE TABLE thread_engine_selections (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id), selection TEXT NOT NULL, override_selection TEXT,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), handoff TEXT
) STRICT;
INSERT INTO thread_engine_selections(thread_id,selection)
SELECT t.id,json_object('engine',coalesce(s.engine,b.engine),'model',NULL,'reasoningEffort',NULL,'speed',NULL)
FROM threads t JOIN bots b ON b.id=t.bot_id LEFT JOIN thread_sessions s ON s.thread_id=t.id;
UPDATE bots SET default_selection=json_object('engine',engine,'model',NULL,'reasoningEffort',NULL,'speed',NULL);
UPDATE turns SET selection=json_object('engine',engine,'model',NULL,'reasoningEffort',NULL,'speed',NULL);
`;

/** Hub SCHEMA_V8; exact blob/reference schema remains part of every authority artifact. */
const HUB_V8 = `
CREATE TABLE image_attachments (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), client_attachment_id TEXT NOT NULL,
 media_type TEXT NOT NULL CHECK(media_type='image/png'), sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 2097152), width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 4096),
 height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 4096), created_at INTEGER NOT NULL CHECK(created_at>=0),
 data BLOB NOT NULL CHECK(length(data)=bytes), UNIQUE(thread_id,client_attachment_id), CHECK(width*height<=16000000)
) STRICT;
CREATE TABLE message_attachments (
 message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES image_attachments(id),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 3), PRIMARY KEY(message_id,ordinal), UNIQUE(message_id,attachment_id)
) STRICT;
`;

/** Hub SCHEMA_V9; table rebuild is reproduced exactly, historical catalogs remain frozen. */
const HUB_V9 = `
CREATE TEMP TABLE dexter_v9_turn_sequence AS SELECT seq FROM sqlite_sequence WHERE name='turns';
CREATE TABLE bots_engine_v9 (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex', 'grok', 'muse', 'antigravity')), created_at INTEGER NOT NULL,
  role_description TEXT NOT NULL DEFAULT '' CHECK (length(role_description) <= 2000),
  avatar_emoji TEXT CHECK (avatar_emoji IS NULL OR length(avatar_emoji) <= 16),
  can_see_bots INTEGER NOT NULL DEFAULT 0 CHECK (can_see_bots IN (0,1)),
  can_receive_orders INTEGER NOT NULL DEFAULT 0 CHECK (can_receive_orders IN (0,1)),
  can_send_actions INTEGER NOT NULL DEFAULT 0 CHECK (can_send_actions IN (0,1)),
  is_master INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), default_selection TEXT
) STRICT;
INSERT INTO bots_engine_v9 SELECT id,owner_id,profile_id,name,engine,created_at,role_description,avatar_emoji,
  can_see_bots,can_receive_orders,can_send_actions,is_master,revision,default_selection FROM bots;
DROP TABLE bots;
ALTER TABLE bots_engine_v9 RENAME TO bots;
CREATE UNIQUE INDEX bots_one_master_per_owner ON bots(owner_id) WHERE is_master = 1;
CREATE TABLE thread_sessions_engine_v9 (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex', 'grok', 'muse', 'antigravity')),
  native_cursor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO thread_sessions_engine_v9 SELECT thread_id,engine,native_cursor,created_at,updated_at FROM thread_sessions;
DROP TABLE thread_sessions;
ALTER TABLE thread_sessions_engine_v9 RENAME TO thread_sessions;
CREATE TABLE turns_engine_v9 (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id),
  bot_id TEXT NOT NULL REFERENCES bots(id), engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex', 'grok', 'muse', 'antigravity')),
  client_request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  input_message_id TEXT NOT NULL REFERENCES messages(id), output_message_id TEXT REFERENCES messages(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'interrupted', 'failed', 'unknown')), code TEXT,
  output_chars INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL,
  selection TEXT, handoff TEXT, UNIQUE (thread_id, client_request_id)
) STRICT;
INSERT INTO turns_engine_v9 SELECT cursor,id,thread_id,bot_id,engine,client_request_id,input_hash,input_message_id,
  output_message_id,state,code,output_chars,output_truncated,created_at,started_at,finished_at,updated_at,selection,handoff
  FROM turns ORDER BY cursor;
DROP TABLE turns;
ALTER TABLE turns_engine_v9 RENAME TO turns;
CREATE INDEX turns_by_thread ON turns (thread_id, cursor);
CREATE INDEX turns_by_state ON turns (state);
INSERT INTO sqlite_sequence(name,seq) SELECT 'turns',seq FROM dexter_v9_turn_sequence
  WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='turns');
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM dexter_v9_turn_sequence),seq)) WHERE name='turns';
DROP TABLE dexter_v9_turn_sequence;
`;

/** Hub SCHEMA_V10; avatar BLOBs remain inside the canonical database snapshot. */
const HUB_V10 = `
CREATE TABLE avatar_images (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, media_type TEXT NOT NULL CHECK(media_type='image/png'),
 sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 2097152), width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1024),
 height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1024), created_at INTEGER NOT NULL CHECK(created_at>=0),
 data BLOB NOT NULL CHECK(length(data)=bytes)
) STRICT;
CREATE TABLE avatar_upload_receipts (
 client_request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, image_id TEXT NOT NULL REFERENCES avatar_images(id),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;
ALTER TABLE bots ADD COLUMN avatar_image_id TEXT REFERENCES avatar_images(id);
`;
const REGISTRY_V2 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE offers (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')), device_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'cancelled', 'exhausted')), attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE claims (
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL UNIQUE REFERENCES offers(id), kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')),
  client_fp TEXT NOT NULL, name TEXT NOT NULL, capabilities TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'rejected', 'failed')),
  device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
) STRICT;
CREATE TABLE device_certs (
  fp TEXT PRIMARY KEY, device_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'revoked')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX device_certs_active ON device_certs (device_id) WHERE state = 'active';
CREATE TABLE late_receipts (
  action_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'unknown')), code TEXT, received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE device_bindings (
  device_id TEXT PRIMARY KEY, fp TEXT NOT NULL UNIQUE REFERENCES device_certs(fp),
  generation INTEGER NOT NULL CHECK (generation >= 1), revision INTEGER NOT NULL CHECK (revision >= generation),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
) STRICT;
`;

const SURFACE_V2 = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE device_routes (id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,device_id TEXT NOT NULL,tool TEXT NOT NULL,
fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,pin_revision INTEGER NOT NULL,schema_hash TEXT NOT NULL,operation_version TEXT NOT NULL,
revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),minimum_grant_revision INTEGER NOT NULL,
UNIQUE(bot_id,device_id,tool)) STRICT;
CREATE TABLE device_calls (turn_id TEXT NOT NULL,call_id TEXT NOT NULL,route_id TEXT NOT NULL,route_revision INTEGER NOT NULL,
bot_id TEXT NOT NULL,thread_id TEXT NOT NULL,device_id TEXT NOT NULL,tool TEXT NOT NULL,fingerprint TEXT NOT NULL,
generation INTEGER NOT NULL,pin_revision INTEGER NOT NULL,schema_hash TEXT NOT NULL,operation_version TEXT NOT NULL,
args_hash TEXT NOT NULL,arguments TEXT NOT NULL,grant_revision INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
action_id TEXT UNIQUE,PRIMARY KEY(turn_id,call_id)) STRICT;
CREATE INDEX device_calls_route ON device_calls(route_id);
CREATE TABLE composite_call_bindings (turn_id TEXT NOT NULL,call_id TEXT NOT NULL,bot_id TEXT NOT NULL,thread_id TEXT NOT NULL,
surface TEXT NOT NULL CHECK(surface IN ('gateway','device')),connection_id TEXT NOT NULL,tool TEXT NOT NULL,args_hash TEXT NOT NULL,
PRIMARY KEY(turn_id,call_id)) STRICT;
`;

const HUB_V11 = `
CREATE TABLE tool_action_continuations (
 action_id TEXT PRIMARY KEY REFERENCES actions(id), origin_turn_id TEXT NOT NULL REFERENCES turns(id),
 profile_id TEXT NOT NULL, call_id TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
 continuation_turn_id TEXT UNIQUE REFERENCES turns(id), receipt_result TEXT, UNIQUE(origin_turn_id,call_id)
) STRICT;
`;

/** Hub SCHEMA_V12: owner policy and immutable request receipts are distinct from grants. */
const HUB_V12 = `
CREATE TABLE bot_approval_policies (
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), owner_id TEXT NOT NULL, host_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('ask','approve_all')), revision INTEGER NOT NULL CHECK(revision >= 0),
 eligible_scope_version TEXT NOT NULL, updated_at INTEGER NOT NULL, receipt_id TEXT
) STRICT;
CREATE TABLE bot_approval_policy_receipts (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), client_request_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(bot_id,client_request_id)
) STRICT;
CREATE TABLE action_authorizations (
 action_id TEXT PRIMARY KEY REFERENCES actions(id), source TEXT NOT NULL CHECK(source IN ('exact_owner','owner_policy','bounded_grant')),
 owner_id TEXT NOT NULL, policy_revision INTEGER, policy_receipt_id TEXT, eligible_scope_version TEXT
) STRICT;
CREATE TABLE proposal_only_grants (
 bot_id TEXT NOT NULL REFERENCES bots(id), tool TEXT NOT NULL, destination TEXT NOT NULL, grant_revision INTEGER NOT NULL,
 PRIMARY KEY(bot_id,tool,destination)
) STRICT;
`;
interface ExactSchema {
  readonly sql: string;
  /** `PRAGMA user_version`, or `null` when the store versions itself only through a meta key. */
  readonly userVersion: number;
  readonly versionKey: { key: string; value: string } | null;
  /** Closed set of meta keys and the two that carry identity. */
  readonly metaKeys: readonly string[];
  readonly ownerKey: string;
  readonly installationKey: string;
  readonly label: string;
}

const HUB_V13 = `
CREATE TABLE bot_execution_access_receipts (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), client_request_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(bot_id,client_request_id)
) STRICT;
CREATE TABLE action_approval_requirements (
 action_id TEXT PRIMARY KEY REFERENCES actions(id), reason TEXT NOT NULL CHECK(reason='access_not_enabled'),
 policy_revision INTEGER NOT NULL CHECK(policy_revision>=0)
) STRICT;
`;
const HUB_V14 = `
ALTER TABLE bot_approval_policies RENAME TO bot_approval_policies_v12;
CREATE TABLE bot_approval_policies (
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), owner_id TEXT NOT NULL, host_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('ask','accept_edits','approve_all','full_access')), revision INTEGER NOT NULL CHECK(revision >= 0),
 eligible_scope_version TEXT NOT NULL, updated_at INTEGER NOT NULL, receipt_id TEXT
) STRICT;
INSERT INTO bot_approval_policies SELECT * FROM bot_approval_policies_v12;
DROP TABLE bot_approval_policies_v12;
ALTER TABLE action_authorizations RENAME TO action_authorizations_v12;
CREATE TABLE action_authorizations (
 action_id TEXT PRIMARY KEY REFERENCES actions(id), source TEXT NOT NULL CHECK(source IN ('exact_owner','owner_policy','bounded_grant','thread_policy','owner_type')),
 owner_id TEXT NOT NULL, policy_revision INTEGER, policy_receipt_id TEXT, eligible_scope_version TEXT
) STRICT;
INSERT INTO action_authorizations SELECT * FROM action_authorizations_v12;
DROP TABLE action_authorizations_v12;
CREATE TABLE thread_approval_policies (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id), policy TEXT NOT NULL
) STRICT;
CREATE TABLE approval_preference_receipts (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), client_request_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(bot_id,client_request_id)
) STRICT;
CREATE TABLE action_approval_contexts (
 action_id TEXT PRIMARY KEY REFERENCES actions(id), context TEXT NOT NULL
) STRICT;
CREATE TABLE approval_type_preferences (
 type_key TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), preference TEXT NOT NULL
) STRICT;
`;
export const EXACT_SCHEMAS: Readonly<Record<ExactKind, ExactSchema>> = Object.freeze({
  hub: {
    sql: `${HUB_V1}${HUB_V2}${HUB_V3}`, userVersion: 3, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v3",
  },
  hub4: {
    sql: `${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}`, userVersion: 4, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v4",
  },
  hub5: {
    sql: `${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}`, userVersion: 5, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v5",
  },
  hub6: {
    sql: `${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}`, userVersion: 6, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v6",
  },
  hub7: {
    sql: `${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}`, userVersion: 7, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v7",
  },
  hub8: {
    sql: `${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}${HUB_V8}`, userVersion: 8, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v8",
  },
  hub9: {
    sql: `PRAGMA foreign_keys=OFF;${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}${HUB_V8}${HUB_V9}PRAGMA foreign_keys=ON;`, userVersion: 9, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v9",
  },
  hub10: {
    sql: `PRAGMA foreign_keys=OFF;${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}${HUB_V8}${HUB_V9}${HUB_V10}PRAGMA foreign_keys=ON;`, userVersion: 10, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v10",
  },
  hub11: {
    sql: `PRAGMA foreign_keys=OFF;${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}${HUB_V8}${HUB_V9}${HUB_V10}${HUB_V11}PRAGMA foreign_keys=ON;`, userVersion: 11, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v11",
  },
  hub14: {
    sql: `PRAGMA foreign_keys=OFF;${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}${HUB_V8}${HUB_V9}${HUB_V10}${HUB_V11}${HUB_V12}${HUB_V13}${HUB_V14}PRAGMA foreign_keys=ON;`, userVersion: 14, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v14",
  },
  hub13: {
    sql: `PRAGMA foreign_keys=OFF;${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}${HUB_V8}${HUB_V9}${HUB_V10}${HUB_V11}${HUB_V12}${HUB_V13}PRAGMA foreign_keys=ON;`, userVersion: 13, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v13",
  },
  hub12: {
    sql: `PRAGMA foreign_keys=OFF;${HUB_V1}${HUB_V2}${HUB_V3}${HUB_V4}${HUB_V5}${HUB_V6}${HUB_V7}${HUB_V8}${HUB_V9}${HUB_V10}${HUB_V11}${HUB_V12}PRAGMA foreign_keys=ON;`, userVersion: 12, versionKey: null,
    metaKeys: ["host_id", "owner_id"], ownerKey: "owner_id", installationKey: "host_id", label: "hub-v12",
  },
  deviceRegistry: {
    sql: REGISTRY_V2, userVersion: 0, versionKey: { key: "schema_version", value: "2" },
    metaKeys: ["installation_id", "owner_id", "schema_version"], ownerKey: "owner_id", installationKey: "installation_id", label: "device-registry-v2",
  },
  deviceSurface: {
    sql: SURFACE_V2, userVersion: 0, versionKey: { key: "schema", value: "2" },
    metaKeys: ["installation", "owner", "schema"], ownerKey: "owner", installationKey: "installation", label: "device-surface-v2",
  },
});

const normalize = (sql: unknown): string | null => (typeof sql === "string" ? sql.replace(/\s+/g, " ").trim().replace(/;$/, "") : null);

type Catalog = string[];
function catalogOf(db: DatabaseSync): Catalog {
  return all(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .map((row) => JSON.stringify([row.type, row.name, row.tbl_name, normalize(row.sql)]));
}

const references = new Map<ExactKind, string>();
/** Reference catalog from executing the canonical SQL in a private in-memory database (no file is touched). */
export function referenceCatalog(kind: ExactKind): string {
  let cached = references.get(kind);
  if (cached === undefined) {
    const db = new DatabaseSync(":memory:");
    try { db.exec(EXACT_SCHEMAS[kind].sql); cached = catalogOf(db).join("\n"); } finally { db.close(); }
    references.set(kind, cached);
  }
  return cached;
}

/** Exact catalog, version marker and closed meta; returns the identity recorded in meta. */
export function checkExactSchema(db: DatabaseSync, kind: ExactKind): Identity {
  try {
    const schema = EXACT_SCHEMAS[kind];
    const version = Number(one(db, "PRAGMA user_version")?.user_version);
    if (version !== schema.userVersion) fail("unsupported_schema", `${kind} database schema version is unsupported`);
    if (catalogOf(db).join("\n") !== referenceCatalog(kind)) fail("unsupported_schema", `${kind} database schema is not the reviewed exact schema`);
    const meta = new Map(all(db, "SELECT key, value FROM meta").map((row) => [String(row.key), row.value]));
    const keys=[...meta.keys()].filter(key=>!((kind==="hub8"||kind==="hub9"||kind==="hub10"||kind==="hub11"||kind==="hub12"||kind==="hub13"||kind==="hub14")&&key===LIVE_VOICE_META_KEY)&&!((kind==="hub9"||kind==="hub10"||kind==="hub11"||kind==="hub12"||kind==="hub13"||kind==="hub14")&&key===BROWSER_USE_META_KEY));
    if (keys.sort().join(",") !== [...schema.metaKeys].sort().join(",")) fail("unsupported_schema", `${kind} database meta is not the reviewed set`);
    if (schema.versionKey && meta.get(schema.versionKey.key) !== schema.versionKey.value) fail("unsupported_schema", `${kind} schema marker is unsupported`);
    const ownerId = meta.get(schema.ownerKey); const installationId = meta.get(schema.installationKey);
    if (typeof ownerId !== "string" || !ownerId || typeof installationId !== "string" || !installationId) {
      fail("identity_mismatch", `${kind} database has no owner or installation`);
    }
    if((kind==="hub8"||kind==="hub9"||kind==="hub10"||kind==="hub11"||kind==="hub12"||kind==="hub13"||kind==="hub14")&&meta.has(LIVE_VOICE_META_KEY)){
      const encoded=meta.get(LIVE_VOICE_META_KEY);let decoded:unknown;
      if(typeof encoded!=="string"||encoded.length>131072)fail("unsupported_schema","Voice metadata is not canonical.");
      try{decoded=JSON.parse(encoded);}catch{fail("unsupported_schema","Voice metadata is not canonical.");}
      const config=LiveVoiceConfigurationSchema.safeParse(decoded);
      if(!config.success||liveVoiceConfigurationJSON(config.data)!==encoded)fail("unsupported_schema","Voice metadata is not canonical.");
      for(const botId of Object.keys(config.data.botVoices))
        if(!one(db,"SELECT id FROM bots WHERE id=? AND owner_id=?",botId,ownerId))fail("reference_broken","Voice metadata references a bot outside its host owner.");
    }
    if((kind==="hub9"||kind==="hub10"||kind==="hub11"||kind==="hub12"||kind==="hub13"||kind==="hub14")&&meta.has(BROWSER_USE_META_KEY)){
      const encoded=meta.get(BROWSER_USE_META_KEY);let decoded:unknown;
      if(typeof encoded!=="string"||Buffer.byteLength(encoded,"utf8")>MAX_BROWSER_USE_METADATA_BYTES)fail("unsupported_schema","Browser metadata is not canonical.");
      try{decoded=JSON.parse(encoded);}catch{fail("unsupported_schema","Browser metadata is not canonical.");}
      const config=BrowserUseConfigurationSchema.safeParse(decoded);
      if(!config.success||browserUseConfigurationJSON(config.data)!==encoded)fail("unsupported_schema","Browser metadata is not canonical.");
      for(const botId of Object.keys(config.data.bots))
        if(!one(db,"SELECT id FROM bots WHERE id=? AND owner_id=?",botId,ownerId))fail("reference_broken","Browser metadata references a bot outside its host owner.");
    }
    return { ownerId, installationId };
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError("corrupt", `${kind} database could not be inspected`, { cause: error });
  }
}

/**
 * Hub of an inspection (version 2) artifact: the historical schema 3 or the current schema 4, chosen by
 * `user_version` and then checked exactly. Inspection copies of schema 4 must carry revoked authority.
 */
export function checkHubExact(db: DatabaseSync): Identity {
  const version = Number(one(db, "PRAGMA user_version")?.user_version);
  const identity = checkExactSchema(db, version === 14 ? "hub14" : version === 13 ? "hub13" : version === 12 ? "hub12" : version === 11 ? "hub11" : version === 10 ? "hub10" : version === 9 ? "hub9" : version === 8 ? "hub8" : version === 7 ? "hub7" : version === 6 ? "hub6" : version === 5 ? "hub5" : version === 4 ? "hub4" : "hub");
  if (version >= 5) checkBotMetadata(db);
  if (version >= 6) checkDelegationMetadata(db);
  if (version >= 7) checkEngineSelectionMetadata(db);
  if (version >= 8) checkImageAttachmentMetadata(db);
  if (version >= 10) checkAvatarImageMetadata(db);
  if (version >= 11) checkToolActionMetadata(db);
  if (version >= 12) checkApprovalPolicyMetadata(db);
  if (version >= 13) checkExecutionAccessMetadata(db);
  return identity;
}
export function hubSchemaVersion(db: DatabaseSync): number { return Number(one(db, "PRAGMA user_version")?.user_version); }

/** Policy state may restore only with its actual host-owner receipt chain and durable action evidence. */
export function checkApprovalPolicyMetadata(db: DatabaseSync): void {
  assertApprovalPreferencesData(db,String(one(db,"SELECT value FROM meta WHERE key='host_id'")?.value),String(one(db,"SELECT value FROM meta WHERE key='owner_id'")?.value));
  const ownerId=one(db,"SELECT value FROM meta WHERE key='owner_id'")?.value;
  const hostId=one(db,"SELECT value FROM meta WHERE key='host_id'")?.value;
  const receipts=new Map<string,BotApprovalPolicyReceipt>();
  const receiptRevisions=new Set<string>();
  for(const row of all(db,"SELECT * FROM bot_approval_policy_receipts")) {
    let receipt:BotApprovalPolicyReceipt;
    try { receipt=BotApprovalPolicyReceiptSchema.parse(JSON.parse(String(row.receipt))); }
    catch { fail("corrupt","Approval policy receipt is invalid."); }
    const policy=receipt.policy,previous=receipt.previous;
    const revisionKey=`${receipt.botId}:${policy.revision}`;
    const bot=one(db,"SELECT * FROM bots WHERE id=?",receipt.botId);
    const input={botId:receipt.botId,ownerId:receipt.ownerId,expectedHostId:receipt.hostId,
      clientRequestId:receipt.clientRequestId,expectedRevision:previous.revision,mode:policy.mode,
      eligibleScopeVersion:policy.eligibleScopeVersion};
    if(canonicalJson(receipt)!==row.receipt || receipt.id!==row.id || receipt.botId!==row.bot_id
      || receipt.clientRequestId!==row.client_request_id || receipt.inputHash!==row.input_hash || receipt.createdAt!==row.created_at
      || createHash("sha256").update(canonicalJson(input)).digest("hex")!==receipt.inputHash
      || receipt.ownerId!==ownerId || receipt.hostId!==hostId || !bot || bot.owner_id!==ownerId
      || [policy,previous].some(value=>value.botId!==receipt.botId || value.ownerId!==ownerId || value.hostId!==hostId)
      || policy.revision!==previous.revision+1 || policy.receiptId!==receipt.id || policy.updatedAt!==receipt.createdAt
      || receiptRevisions.has(revisionKey))
      fail("corrupt","Approval policy receipt binding is invalid.");
    receiptRevisions.add(revisionKey);
    for(const actionId of [...receipt.revocationEffects.blockedActionIds,...receipt.revocationEffects.abortedActionIds])
      if(!one(db,"SELECT id FROM actions WHERE id=? AND bot_id=?",actionId,receipt.botId))
        fail("reference_broken","Approval policy receipt references another bot action.");
    receipts.set(receipt.id,receipt);
  }
  for(const receipt of receipts.values()) {
    const previous=receipt.previous;
    if(previous.revision===0) {
      if(previous.mode!=="ask" || previous.receiptId!==null || previous.updatedAt!==0)
        fail("corrupt","Approval policy receipt has no valid initial policy.");
    } else if(previous.receiptId===null || canonicalJson(receipts.get(previous.receiptId)?.policy??null)!==canonicalJson(previous)) {
      fail("reference_broken","Approval policy receipt history is incomplete.");
    }
  }
  const policies=new Map<string,ReturnType<typeof BotApprovalPolicySchema.parse>>();
  for(const row of all(db,"SELECT * FROM bot_approval_policies")) {
    let policy:ReturnType<typeof BotApprovalPolicySchema.parse>;
    try { policy=BotApprovalPolicySchema.parse({hostId:row.host_id,botId:row.bot_id,ownerId:row.owner_id,mode:row.mode,
      revision:row.revision,eligibleScopeVersion:row.eligible_scope_version,updatedAt:row.updated_at,receiptId:row.receipt_id}); }
    catch { fail("corrupt","Approval policy state is invalid."); }
    if(policy.ownerId!==ownerId || policy.hostId!==hostId || policy.receiptId===null
      || canonicalJson(receipts.get(policy.receiptId)?.policy??null)!==canonicalJson(policy))
      fail("corrupt","Approval policy state has no matching owner receipt.");
    policies.set(policy.botId,policy);
  }
  for(const receipt of receipts.values())
    if(!policies.has(receipt.botId) || receipt.policy.revision>policies.get(receipt.botId)!.revision)
      fail("corrupt","Approval policy receipt is ahead of its state.");
  for(const row of all(db,"SELECT * FROM action_authorizations")) {
    const action=one(db,"SELECT * FROM actions WHERE id=?",String(row.action_id));
    const bot=action && one(db,"SELECT * FROM bots WHERE id=?",String(action.bot_id));
    let authorization:ReturnType<typeof ActionAuthorizationSchema.parse>;
    try { authorization=ActionAuthorizationSchema.parse({source:row.source,ownerId:row.owner_id,
      policyRevision:row.policy_revision,policyReceiptId:row.policy_receipt_id,eligibleScopeVersion:row.eligible_scope_version}); }
    catch { fail("corrupt","Action authorization is invalid."); }
    if(!action || !bot || bot.owner_id!==ownerId || authorization.ownerId!==ownerId)
      fail("reference_broken","Action authorization owner is invalid.");
    if(authorization.source==="owner_policy") {
      const receipt=authorization.policyReceiptId===null?undefined:receipts.get(authorization.policyReceiptId);
      if(!receipt || receipt.botId!==action.bot_id || receipt.policy.mode==="ask"
        || authorization.policyRevision!==receipt.policy.revision || authorization.eligibleScopeVersion!==receipt.policy.eligibleScopeVersion
        || action.decided_by!==ownerId || action.state==="awaiting_approval"
        || ["ready","running"].includes(String(action.state)) && canonicalJson(policies.get(receipt.botId)??null)!==canonicalJson(receipt.policy))
        fail("corrupt","Action policy authorization is not bound to its owner receipt.");
    } else if(!["owner_type","thread_policy"].includes(authorization.source) && (authorization.policyRevision!==null || authorization.policyReceiptId!==null || authorization.eligibleScopeVersion!==null
      || authorization.source==="exact_owner" && action.decided_by!==ownerId)) {
      fail("corrupt","Action authorization source is inconsistent.");
    }
  }
  for(const row of all(db,"SELECT * FROM proposal_only_grants")) {
    const bot=one(db,"SELECT id FROM bots WHERE id=? AND owner_id=?",String(row.bot_id),String(ownerId));
    const grant=one(db,"SELECT * FROM grants WHERE bot_id=? AND tool=? AND destination=?",String(row.bot_id),String(row.tool),String(row.destination));
    if(!bot || !grant || grant.policy!=="ask" || !Number.isSafeInteger(row.grant_revision)
      || row.grant_revision!==grant.revision)
      fail("reference_broken","Proposal-only grant is not bound to its owner grant revision.");
  }
}

/** Durable tool origins are identity bindings, never imported permission grants. */
export function checkToolActionMetadata(db: DatabaseSync): void {
  const owner=one(db,"SELECT value FROM meta WHERE key='owner_id'")?.value;
  for (const row of all(db,"SELECT * FROM tool_action_continuations")) {
    const action=one(db,"SELECT * FROM actions WHERE id=?",String(row.action_id));
    const origin=one(db,"SELECT * FROM turns WHERE id=?",String(row.origin_turn_id));
    const bot=origin && one(db,"SELECT * FROM bots WHERE id=?",String(origin.bot_id));
    if (!action || !origin || !bot || bot.owner_id!==owner || action.bot_id!==origin.bot_id || action.thread_id!==origin.thread_id
      || bot.profile_id!==row.profile_id || typeof row.call_id!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.call_id)
      || ![0,1].includes(Number(row.delivered))) fail("reference_broken","Tool receipt origin is invalid.");
    try{
      const request=ToolRequestSchema.parse(JSON.parse(String(action.request))),encoded=canonicalJson(request);
      if(encoded!==action.request || createHash("sha256").update(encoded).digest("hex")!==action.request_hash
        || request.botId!==origin.bot_id || request.threadId!==origin.thread_id || request.tool!==action.tool
        || request.destination!==action.destination || request.idempotencyKey!==action.idempotency_key)
        fail("corrupt","Tool action request identity is invalid.");
    }catch{fail("corrupt","Tool action request identity is invalid.");}
    if (row.receipt_result!==null) {
      try {
        if (typeof row.receipt_result!=="string" || Buffer.byteLength(row.receipt_result)>1048576
          || canonicalJson(JSON.parse(row.receipt_result))!==row.receipt_result
          || row.receipt_result!=="null" && row.receipt_result!==action.result) fail("corrupt","Tool receipt body is invalid.");
      } catch { fail("corrupt","Tool receipt body is invalid."); }
    }
    if (row.continuation_turn_id!==null) {
      const next=one(db,"SELECT * FROM turns WHERE id=?",String(row.continuation_turn_id));
      if (!next || next.id===origin.id || next.bot_id!==origin.bot_id || next.thread_id!==origin.thread_id
        || next.engine!==origin.engine || next.selection!==origin.selection || next.input_message_id!==origin.input_message_id
        || next.input_hash!==origin.input_hash || !["tool-result-"+action.id,"tool-result-origin-"+origin.id].includes(String(next.client_request_id))
        ) fail("reference_broken","Tool response identity is invalid.");
    }
  }
}

/** Native selections contain protocol values only; restored malformed JSON must fail before startup. */
export function checkEngineSelectionMetadata(db: DatabaseSync): void {
  const historical = hubSchemaVersion(db) < 9;
  const parse = (value: unknown, nullable: boolean): EngineSelection | null => {
    if (nullable && value === null) return null;
    if (typeof value !== "string" || value.length > 4096) fail("corrupt", "Invalid engine selection metadata.");
    try {
      const parsed = EngineSelectionSchema.safeParse(JSON.parse(value));
      if (parsed.success && (!historical || parsed.data.engine === "claude" || parsed.data.engine === "codex")) return parsed.data;
    } catch { /* Provider/config values never enter diagnostics. */ }
    return fail("corrupt", "Invalid engine selection metadata.");
  };
  const handoff = (value: unknown): void => {
    if (value !== null && (typeof value !== "string" || value.length > 13000)) fail("corrupt", "Invalid engine handoff metadata.");
  };
  for (const row of all(db, "SELECT engine,default_selection FROM bots")) {
    const selection = parse(row.default_selection, true);
    if (selection && selection.engine !== row.engine) fail("corrupt", "Bot selection engine disagrees with its profile.");
  }
  for (const row of all(db, "SELECT engine,selection,handoff FROM turns")) {
    const selection = parse(row.selection, true);
    if (selection && selection.engine !== row.engine) fail("corrupt", "Turn selection engine disagrees with its turn.");
    handoff(row.handoff);
  }
  for (const row of all(db, "SELECT selection,override_selection,revision,handoff FROM thread_engine_selections")) {
    const selection = parse(row.selection, false)!;
    const override = parse(row.override_selection, true);
    if (override && (override.engine !== selection.engine || override.model !== selection.model
      || override.reasoningEffort !== selection.reasoningEffort || override.speed !== selection.speed)) fail("corrupt", "Thread override disagrees with its selection.");
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 0) fail("corrupt", "Invalid engine selection revision.");
    handoff(row.handoff);
  }
}

/** Limits and booleans are revalidated before a profile is captured or imported. */
export function checkBotMetadata(db: DatabaseSync): void {
  const historical = hubSchemaVersion(db) < 9;
  for (const row of all(db, "SELECT * FROM bots")) {
    if (historical && row.engine !== "claude" && row.engine !== "codex") fail("corrupt", "Historical bot engine metadata is invalid.");
    for (const field of ["can_see_bots", "can_receive_orders", "can_send_actions", "is_master"]) {
      if (row[field] !== 0 && row[field] !== 1) fail("corrupt", "Invalid bot permission metadata.");
    }
    if (!BotSchema.safeParse({ id: row.id, ownerId: row.owner_id, profileId: row.profile_id, name: row.name,
      engine: row.engine, createdAt: row.created_at, roleDescription: row.role_description, avatarEmoji: row.avatar_emoji,
      canSeeBots: row.can_see_bots === 1, canReceiveOrders: row.can_receive_orders === 1,
      canSendActions: row.can_send_actions === 1, isMaster: row.is_master === 1, revision: row.revision }).success
      || (row.is_master === 1 && row.can_see_bots !== 1)) fail("corrupt", "Invalid bot profile metadata.");
  }
}

export function checkDelegationMetadata(db: DatabaseSync): void {
  const rows = all(db,"SELECT * FROM bot_delegations");
  const roots = new Map<string,number>();
  for (const row of rows) {
    const parsed = BotDelegationSchema.safeParse({id:row.id,sourceBotId:row.source_bot_id,targetBotId:row.target_bot_id,
      sourceThreadId:row.source_thread_id,targetThreadId:row.target_thread_id,sourceTurnId:row.source_turn_id,targetTurnId:row.target_turn_id,
      parentId:row.parent_id,rootId:row.root_id,depth:row.depth,deadlineAt:row.deadline_at,state:row.state,
      createdAt:row.created_at,updatedAt:row.updated_at,result:row.result,requestHash:row.request_hash,callId:row.call_id});
    if (!parsed.success) fail("corrupt","Invalid delegation metadata.");
    const d = parsed.data, source = one(db,"SELECT * FROM turns WHERE id=?",d.sourceTurnId), target = one(db,"SELECT * FROM turns WHERE id=?",d.targetTurnId);
    const root = one(db,"SELECT * FROM turns WHERE id=?",d.rootId);
    if (!source || !target || !root || source.bot_id !== d.sourceBotId || target.bot_id !== d.targetBotId
      || source.thread_id !== d.sourceThreadId || target.thread_id !== d.targetThreadId || d.sourceBotId === d.targetBotId
      || typeof root.started_at !== "number" || d.deadlineAt > root.started_at + 600_000 || d.deadlineAt < d.createdAt)
      fail("corrupt","Delegation references are invalid.");
    const parent = d.parentId ? rows.find(r=>r.id===d.parentId) : null;
    if (parent ? parent.target_turn_id !== d.sourceTurnId || parent.root_id !== d.rootId || Number(parent.depth)+1 !== d.depth || Number(parent.deadline_at) < d.deadlineAt
      : d.depth !== 1 || d.rootId !== d.sourceTurnId) fail("corrupt","Delegation ancestry is invalid.");
    let ancestor = parent; const seen = new Set([d.targetBotId,d.sourceBotId]);
    for (let i=0;ancestor;i++) {
      if (i >= 3 || seen.has(String(ancestor.source_bot_id))) fail("corrupt","Delegation ancestry cycle.");
      seen.add(String(ancestor.source_bot_id)); ancestor = ancestor.parent_id ? rows.find(r=>r.id===ancestor!.parent_id) ?? null : null;
    }
    roots.set(d.rootId,(roots.get(d.rootId) ?? 0)+1);
    if (roots.get(d.rootId)! > 8) fail("corrupt","Delegation root limit exceeded.");
  }
}

/** Durable bytes are revalidated before backup/restore/activation; metadata cannot substitute for an image. */
/** Backup/activation gates validate canonical profile BLOBs, owner bindings, quotas and upload replay receipts. */
export function checkAvatarImageMetadata(db:DatabaseSync):void {
  try{
    const owner=one(db,"SELECT value FROM meta WHERE key='owner_id'")?.value;
    const host=one(db,"SELECT value FROM meta WHERE key='host_id'")?.value;
    let total=0,count=0;
    const images=new Map<string,ReturnType<typeof AvatarImageSchema.parse>>();
    for(const row of all(db,"SELECT * FROM avatar_images")){
      const image=validatePng(row.data as Uint8Array);
      const descriptor=AvatarImageSchema.parse({id:row.id,mediaType:row.media_type,sha256:row.sha256,bytes:row.bytes,
        width:row.width,height:row.height,createdAt:row.created_at});
      if(row.owner_id!==owner || descriptor.sha256!==image.sha256 || descriptor.bytes!==image.bytes
        || descriptor.width!==image.width || descriptor.height!==image.height)fail("corrupt","Invalid avatar media metadata.");
      total+=descriptor.bytes;count+=1;images.set(descriptor.id,descriptor);
    }
    if(count>MAX_AVATAR_IMAGES || total>MAX_AVATAR_STORAGE_BYTES)fail("corrupt","Avatar storage exceeds its budget.");
    const receipts=all(db,"SELECT * FROM avatar_upload_receipts");
    if(receipts.length>MAX_AVATAR_UPLOAD_RECEIPTS)fail("corrupt","Avatar receipt capacity exceeded.");
    for(const row of receipts){
      AvatarImageIdSchema.parse(row.client_request_id);
      const image=images.get(String(row.image_id));
      if(!image || row.owner_id!==owner || !Number.isSafeInteger(row.created_at) || Number(row.created_at)<image.createdAt)
        fail("corrupt","Avatar receipt is not canonical.");
      const hash=createHash("sha256").update(JSON.stringify({hostId:host,ownerId:owner,mediaType:image.mediaType,
        sha256:image.sha256,bytes:image.bytes,width:image.width,height:image.height})).digest("hex");
      if(row.request_hash!==hash)fail("corrupt","Avatar receipt identity mismatch.");
    }
    for(const row of all(db,"SELECT avatar_image_id,owner_id FROM bots WHERE avatar_image_id IS NOT NULL"))
      if(row.owner_id!==owner || !images.has(String(row.avatar_image_id)))fail("reference_broken","Bot avatar media belongs to another owner or is missing.");
  }catch(error){if(error instanceof OperationsError)throw error;throw new OperationsError("corrupt","Avatar media could not be inspected.",{cause:error});}
}

export function checkImageAttachmentMetadata(db:DatabaseSync):void {
  try{
    for(const row of all(db,"SELECT * FROM image_attachments")){
      const image=validatePng(row.data as Uint8Array);
      if(typeof row.id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id)
        || row.client_attachment_id!==row.id || row.media_type!=="image/png" || row.sha256!==image.sha256 || row.bytes!==image.bytes
        || row.width!==image.width || row.height!==image.height || !Number.isSafeInteger(row.created_at) || Number(row.created_at)<0)
        fail("corrupt","Invalid image attachment metadata.");
    }
    const bad=one(db,`SELECT 1 AS bad FROM message_attachments r JOIN messages m ON m.id=r.message_id
      JOIN image_attachments a ON a.id=r.attachment_id WHERE m.thread_id!=a.thread_id OR m.role!='user' LIMIT 1`);
    if(bad)fail("corrupt","Image attachment thread identity mismatch.");
    for(const row of all(db,"SELECT message_id,MIN(ordinal) AS first,MAX(ordinal) AS last,COUNT(*) AS n FROM message_attachments GROUP BY message_id"))
      if(row.first!==0 || Number(row.last)!==Number(row.n)-1)fail("corrupt","Invalid image attachment order.");
  }catch(error){if(error instanceof OperationsError)throw error;throw new OperationsError("corrupt","Image attachments could not be inspected.",{cause:error});}
}

export function checkExecutionAccessMetadata(db:DatabaseSync):void {
  const hostId=one(db,"SELECT value FROM meta WHERE key='host_id'")?.value;
  const ownerId=one(db,"SELECT value FROM meta WHERE key='owner_id'")?.value;
  try { assertBotExecutionAccessData(db,String(hostId),String(ownerId)); }
  catch { fail("corrupt","Execution access receipt metadata is invalid."); }
}
