import type { HostStore } from '@dexter/hub';
import type { MemoryLedgerStore, MemoryLearningCoordinator, MemoryService } from '@dexter/context';

type MaintenanceHost = Pick<HostStore, 'listBots' | 'listTurnsByState' | 'lastMemoryChatActivityAt' | 'now'>;
type MaintenanceLedger = Pick<MemoryLedgerStore, 'listPendingDeletes' | 'listPendingProjections'>;
type MaintenanceService = Pick<MemoryService, 'flushBotDeletes' | 'flushBotProjections'>;
type MaintenanceLearning = Pick<MemoryLearningCoordinator, 'tick' | 'chatStarted'>;

/** One coalesced, lower-priority round. Only approved durable records/tombstones enter backend IO.
 * Uncertain backend effects retain their existing journals; this scheduler does not invent retries. */
export class HostMemoryMaintenance {
  #active: Promise<void> | undefined;
  #controller: AbortController | undefined;
  #stopped = false;
  #nextBot = 0;
  constructor(readonly host: MaintenanceHost, readonly learning: MaintenanceLearning, readonly ledger: MaintenanceLedger,
    readonly service: MaintenanceService, readonly minIdleMs: (botId: string) => number) {}
  #idle(botId?: string): boolean {
    return !this.#stopped && this.host.listTurnsByState('running').length === 0 && this.host.listTurnsByState('queued').length === 0
      && (botId === undefined || this.host.now() - this.host.lastMemoryChatActivityAt() >= this.minIdleMs(botId));
  }
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#active) return this.#active;
    const controller = new AbortController(); this.#controller = controller;
    return this.#active = (async () => {
      await this.learning.tick();
      if (!this.#idle() || controller.signal.aborted) return;
      const bots = this.host.listBots();
      if (!bots.length) return;
      const bot = bots[this.#nextBot++ % bots.length]!;
      if (!this.#idle(bot.id)) return;
      // Empty queues must not trigger lazy provisioning or administrative requests.
      if (this.ledger.listPendingDeletes(bot.id, 1).length > 0)
        await this.service.flushBotDeletes(bot.id, 1, { signal: controller.signal });
      if (!this.#idle(bot.id) || controller.signal.aborted) return;
      if (this.ledger.listPendingProjections(bot.id, { limit: 1 }).items.length > 0)
        await this.service.flushBotProjections(bot.id, 1, { signal: controller.signal });
    })().finally(() => { this.#active = undefined; this.#controller = undefined; });
  }
  chatStarted(): void { this.learning.chatStarted(); this.#controller?.abort(); }
  stopAdmission(): void { this.#stopped = true; this.#controller?.abort(); }
  async close(): Promise<void> { this.stopAdmission(); await this.#active?.catch(() => {}); }
}
