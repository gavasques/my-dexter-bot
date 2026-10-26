export const APPROVAL_PREFERENCES_SQL = `
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
