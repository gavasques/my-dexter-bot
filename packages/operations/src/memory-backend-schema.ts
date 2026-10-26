// Mechanically copied metadata-only SQL from pinned Root memory-backend-store.ts. No custody or key material.
export const MEMORY_BACKEND_SQL = 'CREATE TABLE memory_backend_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>0), origin TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), request_id TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL) STRICT;'
  + 'CREATE TABLE memory_backend_setting_receipts (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;'
  + 'CREATE TRIGGER memory_backend_setting_receipts_no_update BEFORE UPDATE ON memory_backend_setting_receipts BEGIN SELECT RAISE(ABORT,\'immutable backend receipt\'); END;'
  + 'CREATE TRIGGER memory_backend_setting_receipts_no_delete BEFORE DELETE ON memory_backend_setting_receipts BEGIN SELECT RAISE(ABORT,\'immutable backend receipt\'); END;'
  + 'CREATE TABLE memory_backend_provisioning (operation_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN (\'account\',\'bot_user\')), account_id TEXT NOT NULL, user_id TEXT NOT NULL, request_hash TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision>0), state TEXT NOT NULL CHECK(state IN (\'dispatched\',\'recorded\')), receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;';
export const MEMORY_BACKEND_TABLES = ['memory_backend_settings', 'memory_backend_setting_receipts', 'memory_backend_provisioning'] as const;

export const BACKEND_COUNT_TABLES=Object.freeze({backendSettings:'memory_backend_settings',backendSettingReceipts:'memory_backend_setting_receipts',backendProvisioning:'memory_backend_provisioning'});
