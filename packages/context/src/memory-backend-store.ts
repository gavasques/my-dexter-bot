import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { canonicalJson, type HostStore } from '@dexter/hub';
import { z } from 'zod';
import { ContextError } from './types.js';
import { openVikingOrigin } from './openviking-http.js';
import type { OpenVikingProvisioningBinding, OpenVikingProvisioningJournal, OpenVikingProvisioningReceipt } from './openviking-provisioning.js';

/** Metadata only. All credentials are held by the private custody port, never this database or its backup. */
export const MEMORY_BACKEND_SQL = 'CREATE TABLE memory_backend_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>0), origin TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), request_id TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL) STRICT;'
  + 'CREATE TABLE memory_backend_setting_receipts (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;'
  + 'CREATE TRIGGER memory_backend_setting_receipts_no_update BEFORE UPDATE ON memory_backend_setting_receipts BEGIN SELECT RAISE(ABORT,\'immutable backend receipt\'); END;'
  + 'CREATE TRIGGER memory_backend_setting_receipts_no_delete BEFORE DELETE ON memory_backend_setting_receipts BEGIN SELECT RAISE(ABORT,\'immutable backend receipt\'); END;'
  + 'CREATE TABLE memory_backend_provisioning (operation_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN (\'account\',\'bot_user\')), account_id TEXT NOT NULL, user_id TEXT NOT NULL, request_hash TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision>0), state TEXT NOT NULL CHECK(state IN (\'dispatched\',\'recorded\')), receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;';
export const MEMORY_BACKEND_TABLES = ['memory_backend_settings', 'memory_backend_setting_receipts', 'memory_backend_provisioning'] as const;
let expectedCatalog: string | undefined;
export function assertMemoryBackendSchema(db: DatabaseSync): void {
  const placeholders = MEMORY_BACKEND_TABLES.map(() => '?').join(',');
  const catalog = (value: DatabaseSync): string => JSON.stringify(value.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN (' + placeholders + ') ORDER BY type,name').all(...MEMORY_BACKEND_TABLES));
  if (expectedCatalog === undefined) {
    const reference = new DatabaseSync(':memory:');
    try { reference.exec(MEMORY_BACKEND_SQL); expectedCatalog = catalog(reference); } finally { reference.close(); }
  }
  if (catalog(db) !== expectedCatalog) throw new ContextError('tampered');
}
const ID = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const REV = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const MemoryBackendSettingInput = z.object({ expectedHostId: ID, clientRequestId: ID,
  expectedRevision: REV, origin: z.string().min(1).max(512), enabled: z.boolean() }).strict();
export interface MemoryBackendSettings { revision: number; origin: string | null; enabled: boolean; updatedAt: number | null }
export interface MemoryBackendSettingReceipt { hostId: string; ownerId: string; clientRequestId: string;
  requestHash: string; previousRevision: number; settings: MemoryBackendSettings; committedAt: number }
type Row = Record<string, unknown>;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const fail = (code: 'invalid_input' | 'conflict' | 'tampered' | 'forbidden'): never => { throw new ContextError(code); };

/** Trusted host administration. Callers must keep this out of paired HTTP and engine tool registries. */
export class MemoryBackendStore {
  constructor(private readonly db: DatabaseSync, private readonly host: HostStore,
    private readonly write: <T>(f: () => T) => T) {}
  private one(sql: string, ...values: SQLInputValue[]): Row | undefined {
    this.host.assertActiveWriter(); return this.db.prepare(sql).get(...values) as Row | undefined;
  }
  private current(): MemoryBackendSettings {
    const row = this.one('SELECT * FROM memory_backend_settings WHERE singleton=1');
    return row ? { revision: Number(row.revision), origin: String(row.origin), enabled: row.enabled === 1,
      updatedAt: Number(row.updated_at) } : { revision: 0, origin: null, enabled: false, updatedAt: null };
  }
  settings(): MemoryBackendSettings { return this.host.withWriterLease(() => this.current()); }
  receipt(requestId: string): MemoryBackendSettingReceipt | null {
    ID.parse(requestId);
    return this.host.withWriterLease(() => {
      const row = this.one('SELECT receipt_json FROM memory_backend_setting_receipts WHERE request_id=?', requestId);
      return row ? JSON.parse(String(row.receipt_json)) as MemoryBackendSettingReceipt : null;
    });
  }
  /** An explicit local owner action; a new origin/revision invalidates pending provisioning, never redirects it. */
  configure(raw: unknown): MemoryBackendSettingReceipt {
    const parsed = MemoryBackendSettingInput.safeParse(raw); if (!parsed.success) return fail('invalid_input');
    const input = parsed.data;
    let origin: string; try { origin = openVikingOrigin(input.origin); } catch { return fail('invalid_input'); }
    if (input.expectedHostId !== this.host.hostId) return fail('conflict');
    const requestHash = hash(canonicalJson({ ...input, origin }));
    return this.write(() => {
      const prior = this.one('SELECT * FROM memory_backend_setting_receipts WHERE request_id=?', input.clientRequestId);
      if (prior) {
        if (prior.request_hash !== requestHash) return fail('conflict');
        return JSON.parse(String(prior.receipt_json)) as MemoryBackendSettingReceipt;
      }
      const current = this.current(); if (current.revision !== input.expectedRevision) return fail('conflict');
      const committedAt = this.host.now(), revision = current.revision + 1;
      const settings: MemoryBackendSettings = { revision, origin, enabled: input.enabled, updatedAt: committedAt };
      const receipt: MemoryBackendSettingReceipt = { hostId: this.host.hostId, ownerId: this.host.ownerId,
        clientRequestId: input.clientRequestId, requestHash, previousRevision: current.revision, settings, committedAt };
      this.db.prepare('INSERT INTO memory_backend_settings VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,origin=excluded.origin,enabled=excluded.enabled,request_id=excluded.request_id,updated_at=excluded.updated_at')
        .run(revision, origin, input.enabled ? 1 : 0, input.clientRequestId, committedAt);
      this.db.prepare('INSERT INTO memory_backend_setting_receipts VALUES(?,?,?,?)')
        .run(input.clientRequestId, requestHash, canonicalJson(receipt as unknown as Parameters<typeof canonicalJson>[0]), committedAt);
      return receipt;
    });
  }
  /** The journal commits dispatched BEFORE HTTP. Reopening/unknown only reconciles, never repeats a POST. */
  provisioningJournal(expectedRevision: number): OpenVikingProvisioningJournal {
    REV.min(1).parse(expectedRevision);
    const check = (binding: OpenVikingProvisioningBinding): string => {
      if (Object.keys(binding).sort().join(',') !== 'accountId,kind,operationKey,userId'
        || !ID.safeParse(binding.operationKey).success || !['account', 'bot_user'].includes(binding.kind)) return fail('invalid_input');
      const expectedAccount = 'dx1_' + Buffer.from(this.host.hostId, 'utf8').toString('hex');
      if (binding.accountId !== expectedAccount || !/^[A-Za-z0-9_-]{1,261}$/.test(binding.userId)) return fail('forbidden');
      if (binding.kind === 'account') {
        if (binding.userId !== 'svc1_' + Buffer.from(this.host.hostId).toString('hex')) return fail('forbidden');
      } else {
        if (!binding.userId.startsWith('bot1_')) return fail('forbidden');
        const encoded = binding.userId.slice(5); const botId = Buffer.from(encoded, 'hex').toString('utf8');
        if (!encoded || Buffer.from(botId).toString('hex') !== encoded || this.host.getBot(botId).ownerId !== this.host.ownerId) return fail('forbidden');
      }
      const config = this.current();
      if (!config.enabled || config.revision !== expectedRevision) return fail('conflict');
      return hash(canonicalJson({ ...binding, origin: config.origin, configRevision: expectedRevision }));
    };
    return {
      claim: async binding => this.write(() => {
        const requestHash = check(binding);
        const row = this.one('SELECT * FROM memory_backend_provisioning WHERE operation_key=?', binding.operationKey);
        if (row) { if (row.request_hash !== requestHash) return fail('conflict'); return 'reconcile' as const; }
        const now = this.host.now();
        this.db.prepare('INSERT INTO memory_backend_provisioning VALUES(?,?,?,?,?,?,\'dispatched\',NULL,?,?)')
          .run(binding.operationKey, binding.kind, binding.accountId, binding.userId, requestHash, expectedRevision, now, now);
        return 'send' as const;
      }),
      record: async (receipt: OpenVikingProvisioningReceipt) => this.write(() => {
        const binding: OpenVikingProvisioningBinding = { operationKey: receipt.operationKey, kind: receipt.kind,
          accountId: receipt.accountId, userId: receipt.userId };
        const requestHash = check(binding);
        const row = this.one('SELECT * FROM memory_backend_provisioning WHERE operation_key=?', receipt.operationKey);
        if (!row || row.request_hash !== requestHash) return fail('conflict');
        if (!['account_exists', 'identity_verified', 'unknown', 'credential_required', 'blocked_configuration'].includes(receipt.outcome)
          || receipt.content !== 'unproven' || receipt.indexing !== 'unproven') return fail('invalid_input');
        // Select known metadata fields only. A credential accidentally attached by a caller is never persisted.
        const safe = { ...binding, outcome: receipt.outcome, content: 'unproven', indexing: 'unproven' };
        this.db.prepare('UPDATE memory_backend_provisioning SET state=\'recorded\',receipt_json=?,updated_at=? WHERE operation_key=?')
          .run(canonicalJson(safe), this.host.now(), receipt.operationKey);
      }),
    };
  }
}
