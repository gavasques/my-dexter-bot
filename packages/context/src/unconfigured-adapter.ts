import { ContextError, type MemoryAdapter, type RecallRequest, type ServiceHit } from "./types.js";

/** Skills need no network. Recall stays unavailable until the chosen ai-memory backend is configured. */
export class UnconfiguredMemoryAdapter implements MemoryAdapter {
  readonly implementation = "unconfigured" as const;
  readonly targetVersion = "2.5.2" as const;

  async search(_request: RecallRequest): Promise<readonly ServiceHit[]> {
    throw new ContextError("adapter_failed");
  }
}
