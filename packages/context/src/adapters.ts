import { ContextError, type MemoryAdapter, type RecallRequest, type ServiceHit } from "./types.js";

/** Official v2.5.2 read-only search API. No auth references, tokens or automatic global-search fallback. */
export interface AiMemorySearchCall {
  method: "POST"; path: "/api/v1/search";
  body: { q: string; scopes: Array<{ workspace: string; project: string }>; limit: number };
}
export type AiMemoryTransport = (call: AiMemorySearchCall) => Promise<unknown>;
export class AiMemoryReadAdapter implements MemoryAdapter {
  readonly implementation = "ai-memory-read-adapter" as const;
  readonly targetVersion = "2.5.2" as const;
  constructor(private readonly transport: AiMemoryTransport) {}
  async search(request: RecallRequest): Promise<ServiceHit[]> {
    if (request.scopes.length === 0 || request.scopes.length > 25) throw new ContextError("invalid_input");
    try {
      const result = await this.transport({ method: "POST", path: "/api/v1/search", body: {
        q: request.query, scopes: request.scopes.map(({ workspace, project }) => ({ workspace, project })), limit: request.limit,
      } });
      if (!Array.isArray(result) || result.length > 100) throw new ContextError("adapter_failed");
      return result.map((hit: unknown) => {
        if (!hit || typeof hit !== "object") throw new ContextError("adapter_failed");
        const row = hit as Record<string, unknown>;
        if (["workspace", "project", "path"].some(key => typeof row[key] !== "string" || (row[key] as string).length > 512)) throw new ContextError("adapter_failed");
        return { workspace: row.workspace as string, project: row.project as string, path: row.path as string };
      });
    } catch { throw new ContextError("adapter_failed"); } // upstream messages/snippets/auth never enter context
  }
}
/** Fixed query/locale evaluations: no embedding, re-ranking, LLM, network or custom search engine. */
export class FixtureMemoryAdapter implements MemoryAdapter {
  readonly implementation = "fixture" as const;
  readonly targetVersion = "2.5.2" as const;
  constructor(private readonly cases: readonly { query: string; locale: string; hits: readonly ServiceHit[] }[]) {}
  async search(request: RecallRequest): Promise<ServiceHit[]> {
    const hits = this.cases.find(test => test.query === request.query && test.locale === request.locale)?.hits ?? [];
    return hits.filter(hit => request.scopes.some(s => s.workspace === hit.workspace && s.project === hit.project))
      .slice(0, request.limit).map(hit => ({ ...hit }));
  }
}
