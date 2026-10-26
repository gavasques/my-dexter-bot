import type { BotMemoryRevision, BotMemoryHistory, BotMemoryVersion, DocumentMutationReceipt, RestoreBotMemory, OwnDocumentAutomationStatus } from '@dexter/contracts';
/** Owner-authored context of one bot. It grants no tools, permissions or access to peers. */
export interface BotDocuments {
  botId: string;
  revision: number;
  soul: string;
  user: string;
  memory: string;
  updatedAt: number | null;
  memoryHead?: BotMemoryRevision | null;
  receipt?: DocumentMutationReceipt;
  /** Optional live host metadata; absence never implies automatic write support. */
  automation?: OwnDocumentAutomationStatus;
}
export interface SetBotDocuments {
  expectedRevision: number;
  soul: string;
  user: string;
  memory: string;
  clientRequestId?: string | undefined;
  sourceReference?: string | undefined;
}
/** Trusted owner-local administration; absent from paired and raw engine routers. A host-owned facade may admit own-bot approved CAS. */
export interface HostBotDocumentsPort {
  read(botId: string): BotDocuments;
  compareAndSet(botId: string, input: SetBotDocuments): BotDocuments;
  history(botId: string, query?: {limit?: number; before?: string}): BotMemoryHistory;
  readRevision(botId: string, revision: number): BotMemoryVersion;
  restore(botId: string, input: RestoreBotMemory): BotDocuments;
  receipt(botId: string, key: string, threadId?: string): BotDocuments | null;
  /** Exact approved own-bot document action, including limited MEMORY append. Identity/input are host-derived. */
  executeAction(actionId: string): BotDocuments;
}
