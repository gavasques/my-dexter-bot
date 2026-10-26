import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HostError, type HostStore } from '@dexter/hub';
import { MemoryService, OpenVikingIdentityMapper, type MemoryBackendStore, type MemoryServiceAuthority } from '@dexter/context';
import { z } from 'zod';
import { OpenVikingManagedBackend } from './openviking-managed-backend.js';
import { OpenVikingPrivateCustody } from './openviking-private-custody.js';

const ID = z.string().uuid();
const frameCommon = { schema: z.literal('dexter.memory-backend-key/1'), requestId: ID,
  hostID: z.string().min(1).max(128), origin: z.string().min(1).max(512), expectedRevision: z.number().int().positive() };
const PrivateFrame = z.discriminatedUnion('operation', [
  z.object({ ...frameCommon, operation: z.literal('create'), wrappingKeyBase64: z.string().max(48),
    administrativeKey: z.string().min(1).max(4096), administrativeRole: z.enum(['root', 'workspace_admin']) }).strict(),
  z.object({ ...frameCommon, operation: z.literal('unlock'), wrappingKeyBase64: z.string().max(48),
    administrativeRole: z.enum(['root', 'workspace_admin']) }).strict(),
  z.object({ ...frameCommon, operation: z.literal('lock') }).strict(),
]);

/** Owner-local configuration and the app-owned inherited pipe are the only administrative surfaces.
 * No secret body is accepted over HTTP. The backend is external; no process/port is adopted or stopped. */
export class OpenVikingBackendBridge {
  #managed: OpenVikingManagedBackend | null = null;
  #custody: OpenVikingPrivateCustody | null = null;
  #origin: string | null = null;
  #ready = false;
  #stopped = false;
  #generation = 0;
  #lastRequest: { requestId: string; operation: string; revision: number; state: string } | null = null;
  #privateReceipts = new Map<string, { fingerprint: string; status: 'ready' | 'locked' | 'refused' }>();
  #chain: Promise<void> = Promise.resolve();
  constructor(readonly store: HostStore, readonly metadata: MemoryBackendStore, readonly memory: MemoryService,
    readonly admitted: () => void, readonly programmaticBackend = false) {}
  status(): object {
    this.admitted(); const settings = this.metadata.settings();
    return { backend: 'openviking', settings, scope: 'host_owned_account_per_bot_users',
      state: this.programmaticBackend ? 'configured_externally' : !settings.enabled ? 'disabled'
        : this.#origin && this.#origin !== settings.origin ? 'restart_required' : this.#ready ? 'configured_unverified' : 'private_unlock_required',
      administrativeOperations: 'owner_local_only', semanticRecall: 'unproven', externalServiceOwned: false,
      privateRequest: this.#lastRequest ? { ...this.#lastRequest } : null, generation: this.#generation };
  }
  /** A configured origin and a scoped private bot key, still not a live recall/indexing proof. */
  availableForBot(botId: string): boolean {
    try {
      this.admitted(); const config = this.metadata.settings();
      if (this.#stopped || this.programmaticBackend || !this.#ready || !config.enabled || config.origin !== this.#origin
        || this.store.getBot(botId).ownerId !== this.store.ownerId) return false;
      return this.#custody?.hasBotCredential(new OpenVikingIdentityMapper(this.store.hostId).bot(botId)) === true;
    } catch { return false; }
  }
  configure(raw: unknown): unknown {
    this.admitted(); if (this.#stopped || this.programmaticBackend) throw new HostError('conflict', 'This host memory backend is configured externally.');
    const before = this.metadata.settings(); const receipt = this.metadata.configure(raw); const current = this.metadata.settings();
    if (current.revision !== before.revision) {
      ++this.#generation;
      if (!current.enabled || this.#origin !== null && this.#origin !== current.origin) {
        this.#ready = false;
        this.#chain = this.#chain.then(async () => { await this.#managed?.close(); this.#managed = null; this.#custody?.lock(); });
      }
    }
    return { receipt, status: this.status() };
  }
  /** Added to the host capability stamp, so lock/config changes revoke data reads even after HTTP dispatch. */
  authority(base: MemoryServiceAuthority): MemoryServiceAuthority {
    if (this.programmaticBackend) return base;
    const config = this.metadata.settings();
    const available = !this.#stopped && this.#ready && config.enabled && config.origin === this.#origin;
    // Policy remains the host's decision. Custody availability is a generation stamp and a private
    // credential guard, so an unconfigured backend remains a readable, typed configuration state.
    return { ...base,
      authorizationStamp: base.authorizationStamp + '|openviking:' + config.revision + ':' + this.#generation + ':' + Number(available) };
  }
  #file(origin: string): string {
    // Separate from the canonical content directory. Content backup does not copy private custody or Keychain.
    const root = resolve(dirname(this.store.databasePath), '..', 'private-memory-backend');
    const hash = createHash('sha256').update(this.store.hostId + '\0' + this.store.ownerId + '\0' + origin).digest('hex');
    return join(root, 'host-' + hash + '.sealed');
  }
  #privateDirectory(origin: string, create: boolean): void {
    const dir = dirname(this.#file(origin));
    if (!existsSync(dir)) { if (!create) throw new HostError('conflict', 'Private memory custody is missing.'); mkdirSync(dir, { mode: 0o700 }); }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(dir) !== dir || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
      throw new HostError('conflict', 'Private memory custody is unavailable.');
  }
  /** Only bindBrowserUsePrivateInput calls this with a frame from the app-owned FIFO. Values never leave it. */
  privateFrame(raw: unknown): Promise<'ready' | 'locked' | 'refused'> {
    const parsed = PrivateFrame.safeParse(raw);
    if (!parsed.success) return Promise.resolve('refused');
    const input = parsed.data;
    // Session-local exact deduplication. Neither the key nor its fingerprint is persisted or exposed.
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const work = this.#chain.then(async (): Promise<'ready' | 'locked' | 'refused'> => {
      let wrapping: Buffer | undefined;
      try {
        this.admitted(); const config = this.metadata.settings();
        if (this.#stopped || this.programmaticBackend || input.hostID !== this.store.hostId || input.origin !== config.origin
          || input.expectedRevision !== config.revision) return 'refused';
        const previous = this.#privateReceipts.get(input.requestId);
        if (previous) return previous.fingerprint === fingerprint ? previous.status : 'refused';
        if (this.#privateReceipts.size >= 128) return 'refused';
        if (input.operation === 'lock') {
          this.#ready = false; ++this.#generation;
          await this.#managed?.close(); this.#managed = null; this.#custody?.lock();
          this.#lastRequest = { requestId: input.requestId, operation: input.operation, revision: config.revision, state: 'locked' };
          return 'locked';
        }
        if (!config.enabled || this.#origin !== null && this.#origin !== input.origin) return 'refused';
        if (this.#ready || this.#managed) return 'refused';
        wrapping = Buffer.from(input.wrappingKeyBase64, 'base64');
        if (wrapping.length !== 32 || wrapping.toString('base64') !== input.wrappingKeyBase64) return 'refused';
        this.#privateDirectory(input.origin, input.operation === 'create');
        const custody = new OpenVikingPrivateCustody(this.#file(input.origin), {
          hostId: this.store.hostId, ownerId: this.store.ownerId, origin: input.origin });
        if (input.operation === 'create') custody.create(wrapping, input.administrativeKey);
        else custody.unlock(wrapping);
        const managed = new OpenVikingManagedBackend({ store: this.store, metadata: this.metadata, custody,
          origin: input.origin, administrativeRole: input.administrativeRole });
        if (this.#origin === null) {
          const configuration = managed.serviceConfiguration();
          try { this.memory.configureInitialBackend({ ...configuration, backend: { ...configuration.backend!,
            credential: (identity, options) => {
              if (!this.#ready || this.#stopped || !this.#managed) return Promise.reject(new HostError('conflict', 'Private memory custody is locked.'));
              return this.#managed.credential(identity, options?.signal);
            } } }); }
          catch { await managed.close(); return 'refused'; }
        }
        this.#origin = input.origin; this.#custody = custody; this.#managed = managed; this.#ready = true; ++this.#generation;
        this.#lastRequest = { requestId: input.requestId, operation: input.operation, revision: config.revision, state: 'ready' };
        return 'ready';
      } catch { return 'refused'; }
      finally {
        wrapping?.fill(0);
        if (input.operation === 'create') input.administrativeKey = '';
        if (input.operation !== 'lock') input.wrappingKeyBase64 = '';
      }
    });
    const receipt = work.then(status => { if (!this.#privateReceipts.has(input.requestId) && this.#privateReceipts.size < 128)
      this.#privateReceipts.set(input.requestId, { fingerprint, status }); return status; });
    this.#chain = receipt.then(() => {}); return receipt;
  }
  stopAdmission(): void { this.#stopped = true; this.#ready = false; ++this.#generation; this.#managed?.stopAdmission(); }
  async close(): Promise<void> { this.stopAdmission(); await this.#chain; await this.#managed?.close(); this.#custody?.lock(); }
}
