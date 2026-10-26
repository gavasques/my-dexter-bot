import type { HostStore } from '../../packages/hub/dist/index.js';
import type { ContextHost, FixtureMemoryAdapter } from '../../packages/context/dist/index.js';

/** Public seed APIs that the pinned Hub14/Context3 source actually implements.
 * This does not type the old modules as a full current product implementation. */
export type HistoricalSeedHost = Pick<HostStore,
  'createBot' | 'createThread' | 'createTurn' | 'claimNextTurn' | 'finishTurn' |
  'ownerId' | 'hostId' | 'close'>;
export type HistoricalSeedContext = Pick<ContextHost,
  'createMemory' | 'createTeam' | 'assignBot' | 'setMember' | 'setRecallGrant' |
  'issue' | 'revoke' | 'proposePromotion' | 'approvePromotion' |
  'reversePromotion' | 'close'>;
export interface HistoricalSeedModules {
  hub: {
    HostStore: new (options: { dataDir: string }) => HistoricalSeedHost;
    SCHEMA_VERSION: 14;
  };
  context: {
    ContextHost: new (host: HistoricalSeedHost, adapter: FixtureMemoryAdapter) => HistoricalSeedContext;
    FixtureMemoryAdapter: typeof FixtureMemoryAdapter;
  };
  operations: unknown;
}
export function historicalBaseline(): Promise<HistoricalSeedModules>;
export function campaignLab(prefix: string): string;
export function campaignEvidence(label: string, evidence: object): void;
export function campaignSDKProbe(name: 'GroupsSDKProbe' | 'NativeVoiceSDKProbe'): Promise<string>;
