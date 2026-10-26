import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { type HostStore } from '@dexter/hub';
import { MemoryBackendStore, OpenVikingProvisioner, OpenVikingIdentityMapper, openVikingOrigin,
  type MemoryServiceConfiguration, type OpenVikingBotIdentity, type OpenVikingCredentialCustody,
  type OpenVikingProvisioningReceipt } from '@dexter/context';
import { OpenVikingPrivateCustody } from './openviking-private-custody.js';

export class OpenVikingBackendError extends Error {
  constructor(readonly code: 'configuration_required' | 'private_unlock_required' | 'provisioning_unconfirmed' | 'closed') {
    super('OpenViking backend ' + code); this.name = 'OpenVikingBackendError';
  }
}
export interface OpenVikingManagedBackendOptions {
  store: HostStore; metadata: MemoryBackendStore; custody: OpenVikingPrivateCustody; origin: string;
  administrativeRole: 'root' | 'workspace_admin';
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
/** One external service, one host-derived account, one user per bot. No implicit startup, account
 * adoption, credential discovery, global ROOT data fallback or retry of an uncertain administrative POST. */
export class OpenVikingManagedBackend {
  readonly #options: Readonly<OpenVikingManagedBackendOptions>;
  readonly #mapper: OpenVikingIdentityMapper;
  readonly #provisioners = new Set<OpenVikingProvisioner>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #controllers = new Set<AbortController>();
  readonly #bots = new Map<string, Promise<string | null>>();
  #closed = false;
  constructor(options: OpenVikingManagedBackendOptions) {
    if (!(options.metadata instanceof MemoryBackendStore) || !(options.custody instanceof OpenVikingPrivateCustody)
      || !['root', 'workspace_admin'].includes(options.administrativeRole)) throw new OpenVikingBackendError('configuration_required');
    this.#options = Object.freeze({ ...options, origin: openVikingOrigin(options.origin) });
    this.#mapper = new OpenVikingIdentityMapper(options.store.hostId);
  }
  toJSON(): { backend: string; state: string; account: string; administrativeScope: string; credentialValues: string } {
    const config = this.#options.metadata.settings();
    return { backend: 'openviking', state: this.#closed ? 'closed' : !config.enabled || config.origin !== this.#options.origin
      ? 'configuration_required' : !this.#options.custody.toJSON().unlocked ? 'private_unlock_required' : 'configured_unverified',
      account: this.#mapper.accountId, administrativeScope: this.#options.administrativeRole, credentialValues: 'private' };
  }
  [inspect.custom](): string { return 'OpenVikingManagedBackend(' + this.toJSON().state + ')'; }
  #guard(revision?: number): number {
    if (this.#closed) throw new OpenVikingBackendError('closed');
    const config = this.#options.metadata.settings();
    if (!config.enabled || config.origin !== this.#options.origin || revision !== undefined && revision !== config.revision)
      throw new OpenVikingBackendError('configuration_required');
    if (!this.#options.custody.toJSON().unlocked) throw new OpenVikingBackendError('private_unlock_required');
    return config.revision;
  }
  #key(identity: OpenVikingBotIdentity, revision: number, kind: string): string {
    return 'ovp1_' + createHash('sha256').update(JSON.stringify([this.#options.store.hostId, this.#options.origin,
      revision, kind, identity.accountId, kind === 'account' ? null : identity.userId])).digest('hex');
  }
  serviceConfiguration(): MemoryServiceConfiguration {
    return { backend: { origin: this.#options.origin, timeoutMs: 10_000, maxResponseBytes: 65_536,
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      credential: (identity, options) => this.credential(identity, options?.signal) } };
  }
  /** Identity is minted and revalidated by the canonical service, not selected by a model body. */
  credential(identity: OpenVikingBotIdentity, signal?: AbortSignal): Promise<string | null> {
    const revision = this.#guard();
    if (identity.workspaceId !== this.#options.store.hostId || this.#options.store.getBot(identity.botId).ownerId !== this.#options.store.ownerId
      || identity.accountId !== this.#mapper.accountId || identity.userId !== this.#mapper.bot(identity.botId).userId)
      return Promise.reject(new OpenVikingBackendError('configuration_required'));
    const key = String(revision) + ':' + identity.botId;
    // Concurrent jobs share provisioning. They still await their own cancellation guard; no second POST.
    const existing = this.#bots.get(key);
    if (existing) return existing.then(result => { this.#guard(revision); if (signal?.aborted) throw new OpenVikingBackendError('closed'); return result; });
    const controller = new AbortController(); this.#controllers.add(controller);
    const abort = (): void => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const job = this.#credential(identity, revision, controller.signal);
    this.#bots.set(key, job); this.#pending.add(job);
    void job.finally(() => { signal?.removeEventListener('abort', abort); this.#controllers.delete(controller);
      this.#bots.delete(key); this.#pending.delete(job); }).catch(() => {});
    return job;
  }
  async #credential(identity: OpenVikingBotIdentity, revision: number, signal: AbortSignal): Promise<string | null> {
    this.#guard(revision); if (signal.aborted) throw new OpenVikingBackendError('closed');
    const custody: OpenVikingCredentialCustody = {
      load: async value => { this.#guard(revision); const result = await this.#options.custody.load(value); this.#guard(revision); return result; },
      save: async (value, key) => { this.#guard(revision); if (signal.aborted) throw new OpenVikingBackendError('closed');
        await this.#options.custody.save(value, key); this.#guard(revision); },
    };
    const provisioner = new OpenVikingProvisioner({ origin: this.#options.origin,
      rootCredential: () => { this.#guard(revision); return this.#options.custody.administrativeKey(); },
      administrativeRole: this.#options.administrativeRole, journal: this.#options.metadata.provisioningJournal(revision), custody,
      timeoutMs: 10_000, maxResponseBytes: 65_536, ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}) });
    this.#provisioners.add(provisioner);
    try {
      let receipt: OpenVikingProvisioningReceipt;
      if (this.#options.administrativeRole === 'root') {
        receipt = await provisioner.ensureAccount(identity, this.#key(identity, revision, 'account'), { signal });
        this.#guard(revision);
        if (receipt.outcome !== 'account_exists') throw new OpenVikingBackendError('provisioning_unconfirmed');
      }
      receipt = await provisioner.ensureBot(identity, this.#key(identity, revision, 'bot'), { signal });
      this.#guard(revision); if (signal.aborted) throw new OpenVikingBackendError('closed');
      if (receipt.outcome !== 'identity_verified') throw new OpenVikingBackendError('provisioning_unconfirmed');
      const key = await custody.load(identity); this.#guard(revision); return key;
    } catch (error) {
      this.#guard(revision);
      if (error instanceof OpenVikingBackendError) throw error;
      throw new OpenVikingBackendError('provisioning_unconfirmed');
    } finally { provisioner.close(); this.#provisioners.delete(provisioner); }
  }
  stopAdmission(): void { this.#closed = true; for (const c of this.#controllers) c.abort(); for (const p of this.#provisioners) p.close(); }
  /** Never locks custody before all credential/save closures have actually settled. */
  async close(): Promise<void> {
    this.stopAdmission(); await Promise.allSettled([...this.#pending]); this.#options.custody.lock();
  }
}
