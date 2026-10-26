import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { MemoryLedgerStore } from "./memory-ledger.js";
import type { MemoryRecordReference } from "./memory-ledger.js";
import { OpenVikingAdapter } from "./openviking-adapter.js";
import type { OpenVikingProjectionJournal, OpenVikingProjectionReceipt } from "./openviking-adapter.js";
import { OpenVikingIdentityMapper, OPENVIKING_UPSTREAM_PIN, openVikingRevisionUri, validateOpenVikingUserKey } from "./openviking-identity.js";
import type { OpenVikingBotIdentity, OpenVikingRevisionRef } from "./openviking-identity.js";
import { openVikingBounded, openVikingOrigin } from "./openviking-http.js";
import type { OpenVikingHttpOptions } from "./openviking-http.js";
import { ContextError } from "./types.js";

export const MEMORY_SERVICE_LIMITS = Object.freeze({ searchCandidates: 20, details: 6, detailBytes: 8192, totalBytes: 32768,
  evidenceRefs: 8, evidenceBytes: 2048, referenceBytes: 512, queryCharacters: 2000, projectionBatch: 20 });
export type MemoryServiceErrorCode = "blocked_configuration" | "forbidden" | "revoked" | "invalid_input" | "not_implemented" | "backend_unavailable" | "deadline" | "closed" | "cleanup_incomplete";
export type MemoryServiceRecoveryCode = "configure_backend" | "provide_bot_user_key" | "configure_identity_binding" | "new_authorized_turn" | "inspect_backend" | "team_memory_pending" | "retry_cleanup";
/** Values, causes, provider response bodies and credential exceptions never cross this facade. */
export class MemoryServiceError extends Error {
  constructor(readonly code: MemoryServiceErrorCode, readonly recovery: MemoryServiceRecoveryCode | null = null) {
    super(`Memory service ${code}`); this.name = "MemoryServiceError";
  }
}
/** Host-only resolver of a CURRENT Context capability, never accepted from a tool body. */
export interface MemoryServiceAuthority {
  readonly workspaceId: string; readonly botId: string; readonly turnId: string; readonly threadId: string;
  readonly audience: "private" | "team"; readonly authorizationStamp: string; readonly privateRecallAllowed: boolean;
}
export interface MemoryServiceBackendOptions extends OpenVikingHttpOptions {
  /** Private host custody. Null means no user key has been provisioned; no implicit admin/root fallback. */
  credential: (identity: OpenVikingBotIdentity, options?: Readonly<{ signal: AbortSignal }>) => string | null | Promise<string | null>;
}
/** Borrowed contract implemented by the real supervisor. Construction never starts a process. */
export interface MemoryServiceSupervisor {
  stop(): Promise<{ complete: boolean }>;
}
export interface MemoryServiceConfiguration {
  backend?: MemoryServiceBackendOptions; supervisor?: MemoryServiceSupervisor;
  /** Host-only whole-job response deadline, including custody/all HTTP/details/projection batch. 1..120000 ms;
   * default 30000. Timeout bounds the caller, never proves an uncooperative owned closure has drained. */
  jobTimeoutMs?: number;
}
export interface MemoryServiceOptions extends MemoryServiceConfiguration {
  workspaceId: string; ledger: MemoryLedgerStore; resolveAuthority: (token: string) => MemoryServiceAuthority;
}
export interface MemoryServiceDiagnostic {
  backend: "openviking"; state: "blocked_configuration" | "configured_unverified" | "stopping" | "closed";
  reason: "missing_backend" | null; semanticRecall: "unproven"; teamRecall: "not_implemented"; confidentialRecall: "not_implemented";
  automaticCapture: false; projection: "durable_manual_flush"; upstreamPin: string;
  jobTimeoutMs: number;
}
export interface MemoryServiceMemory extends OpenVikingRevisionRef {
  markdown: string; score: number | null;
  provenance: { backend: "openviking"; uri: string; canonical: "context-ledger"; evidence: { kind: "ledger_reference"; reference: string }[] };
}

/** Pure validation/snapshot for HostServices BEFORE it opens the canonical store. No IO, provider read or disposal. */
export function snapshotMemoryServiceConfiguration(raw: MemoryServiceConfiguration | undefined): Readonly<MemoryServiceConfiguration> {
  if (raw === undefined) return Object.freeze({});
  try {
    const config = { ...raw };
    if (Object.keys(config).some(key => !["backend", "supervisor", "jobTimeoutMs"].includes(key))) throw new Error();
    const jobTimeoutMs = openVikingBounded(config.jobTimeoutMs, 30000, 1, 120000);
    let backend: Readonly<MemoryServiceBackendOptions> | undefined;
    if (config.backend !== undefined) {
      const source = config.backend, row = { ...source };
      if (Object.keys(row).some(key => !["origin", "credential", "fetch", "timeoutMs", "maxResponseBytes"].includes(key)) ||
        typeof row.credential !== "function" || row.fetch !== undefined && typeof row.fetch !== "function") throw new Error();
      backend = Object.freeze({ origin: openVikingOrigin(row.origin), credential: row.credential.bind(source),
        timeoutMs: openVikingBounded(row.timeoutMs, 10000, 1, 120000),
        maxResponseBytes: openVikingBounded(row.maxResponseBytes, 65536, 256, 65536),
        ...(row.fetch === undefined ? {} : { fetch: row.fetch.bind(source) }) });
    }
    let supervisor: Readonly<MemoryServiceSupervisor> | undefined;
    if (config.supervisor !== undefined) {
      const source = config.supervisor, stop = source.stop;
      if (typeof stop !== "function") throw new Error();
      supervisor = Object.freeze({ stop: stop.bind(source) });
    }
    return Object.freeze({ jobTimeoutMs, ...(backend ? { backend } : {}), ...(supervisor ? { supervisor } : {}) });
  } catch { throw new MemoryServiceError("blocked_configuration", "configure_backend"); }
}

const deny = (): never => { throw new MemoryServiceError("forbidden", "new_authorized_turn"); };
const closedInput = (input: unknown, keys: string[]): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new MemoryServiceError("invalid_input");
  return input as Record<string, unknown>;
};
const sameIdentity = (a: OpenVikingBotIdentity, b: { mapperVersion: number; workspaceId: string; botId: string; accountId: string; userId: string }): boolean =>
  a.mapperVersion === b.mapperVersion && a.workspaceId === b.workspaceId && a.botId === b.botId && a.accountId === b.accountId && a.userId === b.userId;

/** Internal host facade. It has no engine routes, mutation manifests, account/user overrides or backend fallback. */
export class MemoryService {
  readonly #mapper: OpenVikingIdentityMapper;
  readonly #ledger: MemoryLedgerStore;
  readonly #authority: MemoryServiceOptions["resolveAuthority"];
  readonly #configuration: Readonly<MemoryServiceConfiguration>;
  readonly #calls = new Set<Promise<unknown>>();
  readonly #adapters = new Set<OpenVikingAdapter>();
  readonly #controllers = new Set<AbortController>();
  readonly #deadlines = new WeakMap<AbortSignal, { controller: AbortController; at: number }>();
  #stopping = false; #closed = false; #closing: Promise<void> | null = null;
  constructor(options: MemoryServiceOptions) {
    try { this.#mapper = new OpenVikingIdentityMapper(options.workspaceId); }
    catch { throw new MemoryServiceError("blocked_configuration", "configure_identity_binding"); }
    if (!(options.ledger instanceof MemoryLedgerStore) || typeof options.resolveAuthority !== "function") throw new MemoryServiceError("blocked_configuration", "configure_identity_binding");
    this.#ledger = options.ledger; this.#authority = options.resolveAuthority;
    this.#configuration = snapshotMemoryServiceConfiguration({ ...(options.backend ? { backend: options.backend } : {}), ...(options.supervisor ? { supervisor: options.supervisor } : {}),
      ...(options.jobTimeoutMs === undefined ? {} : { jobTimeoutMs: options.jobTimeoutMs }) });
  }
  toJSON(): MemoryServiceDiagnostic { return this.diagnostic(); }
  [inspect.custom](): string { return `MemoryService(${this.diagnostic().state})`; }
  diagnostic(): MemoryServiceDiagnostic {
    return { backend: "openviking", state: this.#closed ? "closed" : this.#stopping ? "stopping" : this.#configuration.backend ? "configured_unverified" : "blocked_configuration",
      reason: this.#configuration.backend ? null : "missing_backend", semanticRecall: "unproven", teamRecall: "not_implemented", confidentialRecall: "not_implemented",
      automaticCapture: false, projection: "durable_manual_flush", upstreamPin: OPENVIKING_UPSTREAM_PIN, jobTimeoutMs: this.#configuration.jobTimeoutMs ?? 30000 };
  }
  #admitted(): void { if (this.#stopping || this.#closed) throw new MemoryServiceError("closed"); }
  #job(signal: AbortSignal): void {
    const deadline = this.#deadlines.get(signal);
    if (!signal.aborted && deadline && performance.now() >= deadline.at) deadline.controller.abort(new MemoryServiceError("deadline"));
    if (signal.aborted) throw new MemoryServiceError(signal.reason instanceof MemoryServiceError && signal.reason.code === "deadline" ? "deadline" : "closed");
    this.#admitted();
  }
  #resolve(token: string): Readonly<MemoryServiceAuthority> {
    this.#admitted();
    try {
      const a = this.#authority(token);
      if (a.workspaceId !== this.#mapper.workspaceId || typeof a.botId !== "string" || !a.botId ||
        typeof a.turnId !== "string" || !a.turnId || typeof a.threadId !== "string" || !a.threadId ||
        !["private", "team"].includes(a.audience) || typeof a.privateRecallAllowed !== "boolean" ||
        typeof a.authorizationStamp !== "string" || !a.authorizationStamp || a.authorizationStamp.length > 32768) return deny();
      return Object.freeze({ workspaceId: a.workspaceId, botId: a.botId, turnId: a.turnId, threadId: a.threadId,
        audience: a.audience, authorizationStamp: a.authorizationStamp, privateRecallAllowed: a.privateRecallAllowed });
    } catch (error) { if (error instanceof MemoryServiceError) throw error; return deny(); }
  }
  #check(token: string, original: Readonly<MemoryServiceAuthority>, scopeEpoch: number): void {
    const current = this.#resolve(token);
    if (JSON.stringify(current) !== JSON.stringify(original) || this.#ledger.scopeEpoch({ kind: "bot", botId: original.botId }) !== scopeEpoch)
      throw new MemoryServiceError("revoked", "new_authorized_turn");
  }
  #private(a: Readonly<MemoryServiceAuthority>): void {
    if (a.audience === "team") throw new MemoryServiceError("not_implemented", "team_memory_pending");
    if (!a.privateRecallAllowed) deny();
  }
  #identity(botId: string): OpenVikingBotIdentity {
    const identity = this.#mapper.bot(botId);
    try {
      // Local deterministic descriptor only. This never provisions remote accounts/users or reads a root/admin key.
      const persisted = this.#ledger.provisionBotSubject(botId);
      if (!sameIdentity(identity, persisted)) throw new Error();
    } catch { throw new MemoryServiceError("blocked_configuration", "configure_identity_binding"); }
    return identity;
  }
  #active(botId: string, ref: OpenVikingRevisionRef, epoch: number): MemoryRecordReference & { content: string; evidenceRefs: string[] } {
    const result = this.#ledger.readActiveReference(botId, { ...ref, scopeEpoch: epoch });
    if (result.scope.kind !== "bot" || result.botId !== botId) return deny();
    return result;
  }
  #track<T>(promise: Promise<T>): Promise<T> {
    this.#calls.add(promise); void promise.then(() => this.#calls.delete(promise), () => this.#calls.delete(promise)); return promise;
  }
  #response(response: Response, check: () => void): Response {
    if (!response.body) return response;
    const reader = response.body.getReader(); let finished = false;
    const finish = () => { if (!finished) { reader.releaseLock(); finished = true; } };
    // Headers arriving is not proof that the body reader drained. Track its real await separately
    // when an adapter timeout races the transport, and discard a late chunk before any decoding.
    const body = new ReadableStream<Uint8Array>({
      pull: controller => this.#track(Promise.resolve().then(async () => {
        try {
          check(); const chunk = await reader.read(); check();
          if (chunk.done) { finish(); controller.close(); } else controller.enqueue(chunk.value);
        } catch { finish(); controller.error(new MemoryServiceError("backend_unavailable")); }
      })),
      cancel: () => this.#track(Promise.resolve().then(async () => { try { await reader.cancel(); } finally { finish(); } })),
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  #run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try { this.#admitted(); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(); this.#controllers.add(controller);
    const timeoutMs = this.#configuration.jobTimeoutMs ?? 30000;
    this.#deadlines.set(controller.signal, { controller, at: performance.now() + timeoutMs });
    let onAbort: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new MemoryServiceError(controller.signal.reason instanceof MemoryServiceError && controller.signal.reason.code === "deadline" ? "deadline" : "closed"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new MemoryServiceError("deadline")), timeoutMs);
    // The underlying work stays tracked after the caller's deadline. Ignored custody abort cannot
    // turn a raced response into proof that Context/HostStore may close.
    const call = Promise.resolve().then(async () => { try { this.#job(controller.signal); const result = await work(controller.signal); this.#job(controller.signal); return result; }
      catch (error) {
        if (error instanceof MemoryServiceError) throw error;
        if (error instanceof ContextError && error.code === "invalid_input") throw new MemoryServiceError("invalid_input");
        if (error instanceof ContextError && ["forbidden", "conflict", "not_found"].includes(error.code)) throw new MemoryServiceError("revoked", "new_authorized_turn");
        throw new MemoryServiceError("backend_unavailable", "inspect_backend");
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort!);
        // A transport may have returned its own earlier timeout while its injected fetch is still pending.
        // Finish this job's signal too: that late closure may only drain, never re-enter authority or HTTP.
        if (!controller.signal.aborted) controller.abort(new MemoryServiceError("closed"));
        this.#deadlines.delete(controller.signal); this.#controllers.delete(controller);
      } });
    this.#track(call); return Promise.race([call, interrupted]);
  }
  async #adapter(identity: OpenVikingBotIdentity, check: () => void, signal: AbortSignal, journal?: OpenVikingProjectionJournal): Promise<OpenVikingAdapter> {
    check(); const backend = this.#configuration.backend;
    if (!backend) throw new MemoryServiceError("blocked_configuration", "configure_backend");
    let key: string | null;
    try { key = await backend.credential(identity, Object.freeze({ signal })); }
    catch { check(); throw new MemoryServiceError("blocked_configuration", "provide_bot_user_key"); }
    check();
    if (key === null) throw new MemoryServiceError("blocked_configuration", "provide_bot_user_key");
    try { validateOpenVikingUserKey(key, identity); }
    catch { throw new MemoryServiceError("blocked_configuration", "provide_bot_user_key"); }
    const fixedKey = key;
    const ownedFetch: NonNullable<OpenVikingHttpOptions["fetch"]> = async (url, init) => {
      check();
      // Retain the real fetch closure even if the transport races a response timeout/cancellation.
      const result = await this.#track(Promise.resolve().then(() => { check(); return (backend.fetch ?? fetch)(url, init); }));
      check(); return this.#response(result, check);
    };
    const adapter = new OpenVikingAdapter({ ...backend, fetch: ownedFetch, identity, credential: () => { check(); return fixedKey; }, ...(journal ? { journal } : {}) });
    this.#adapters.add(adapter); return adapter;
  }
  #dispose(adapter: OpenVikingAdapter | undefined): void { if (adapter) { adapter.close(); this.#adapters.delete(adapter); } }
  status(token: string): Promise<MemoryServiceDiagnostic & { identityVerified: boolean; content: "unproven"; indexing: "unproven" }> {
    return this.#run(async signal => {
      const a = this.#resolve(token); this.#private(a);
      if (!this.#configuration.backend) return { ...this.diagnostic(), identityVerified: false, content: "unproven", indexing: "unproven" };
      const identity = this.#identity(a.botId), epoch = this.#ledger.scopeEpoch({ kind: "bot", botId: a.botId });
      const check = () => { this.#job(signal); this.#check(token, a, epoch); }; let adapter: OpenVikingAdapter | undefined;
      try { adapter = await this.#adapter(identity, check, signal); check(); const result = await adapter.status({ signal }); check();
        return { ...this.diagnostic(), identityVerified: result.identityVerified, content: result.content, indexing: result.indexing };
      } catch (error) { check(); throw error;
      } finally { this.#dispose(adapter); }
    });
  }
  #materialize(record: MemoryRecordReference & { content: string; evidenceRefs: string[] }, uri: string, score: number | null): MemoryServiceMemory | null {
    if (Buffer.byteLength(record.content, "utf8") > MEMORY_SERVICE_LIMITS.detailBytes) return null;
    const evidence: MemoryServiceMemory["provenance"]["evidence"] = []; let bytes = 0;
    for (const reference of record.evidenceRefs) {
      const size = Buffer.byteLength(reference, "utf8");
      if (size > MEMORY_SERVICE_LIMITS.referenceBytes || bytes + size > MEMORY_SERVICE_LIMITS.evidenceBytes || evidence.length >= MEMORY_SERVICE_LIMITS.evidenceRefs) continue;
      evidence.push({ kind: "ledger_reference", reference }); bytes += size;
    }
    return { recordId: record.recordId, revision: record.revision, sha256: record.sha256, markdown: record.content, score,
      provenance: { backend: "openviking", uri, canonical: "context-ledger", evidence } };
  }
  read(token: string, input: OpenVikingRevisionRef): Promise<MemoryServiceMemory | null> {
    return this.#run(async signal => {
      const row = closedInput(input, ["recordId", "revision", "sha256"]);
      if (typeof row.recordId !== "string" || typeof row.revision !== "number" || typeof row.sha256 !== "string") throw new MemoryServiceError("invalid_input");
      const ref = Object.freeze({ recordId: row.recordId, revision: row.revision, sha256: row.sha256 });
      const a = this.#resolve(token); this.#private(a);
      const identity = this.#identity(a.botId), epoch = this.#ledger.scopeEpoch({ kind: "bot", botId: a.botId });
      const check = () => { this.#job(signal); this.#check(token, a, epoch); }; this.#active(a.botId, ref, epoch);
      let adapter: OpenVikingAdapter | undefined;
      try {
        adapter = await this.#adapter(identity, check, signal); check(); this.#active(a.botId, ref, epoch);
        const remote = await adapter.read(ref, { signal }); check(); const record = this.#active(a.botId, ref, epoch);
        if (remote.kind === "missing") return null;
        // Hash is verified by adapter and ledger, and bytes are returned only from the CURRENT canonical head.
        const uri = openVikingRevisionUri(identity, ref);
        check(); return this.#materialize(record, uri, null);
      } catch (error) {
        // The transport sanitizes errors from its fetch/body reader. Recheck host authority
        // and the canonical head before classifying that sanitized failure as backend IO.
        check(); this.#active(a.botId, ref, epoch); throw error;
      } finally { this.#dispose(adapter); }
    });
  }
  recall(token: string, input: { query: string; limit?: number }): Promise<MemoryServiceMemory[]> {
    return this.#run(async signal => {
      const row = closedInput(input, ["query", "limit"]), limit = row.limit ?? MEMORY_SERVICE_LIMITS.details;
      if (typeof row.query !== "string" || !row.query.trim() || !row.query.isWellFormed() || row.query.length > MEMORY_SERVICE_LIMITS.queryCharacters ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_SERVICE_LIMITS.details) throw new MemoryServiceError("invalid_input");
      const query = row.query, a = this.#resolve(token); this.#private(a);
      const identity = this.#identity(a.botId), epoch = this.#ledger.scopeEpoch({ kind: "bot", botId: a.botId });
      const check = () => { this.#job(signal); this.#check(token, a, epoch); }; let adapter: OpenVikingAdapter | undefined;
      try {
        adapter = await this.#adapter(identity, check, signal); check();
        const hits = await adapter.recall({ query, limit: MEMORY_SERVICE_LIMITS.searchCandidates }, { signal }); check();
        const output: MemoryServiceMemory[] = []; let bytes = 0, detailsRead = 0;
        for (const hit of hits) {
          if (detailsRead >= MEMORY_SERVICE_LIMITS.details) break;
          check(); const ref = { recordId: hit.recordId, revision: hit.revision, sha256: hit.sha256 };
          try { const current = this.#active(a.botId, ref, epoch), size = Buffer.byteLength(current.content, "utf8"); if (size > MEMORY_SERVICE_LIMITS.detailBytes || bytes + size > MEMORY_SERVICE_LIMITS.totalBytes) continue; }
          catch (error) { if (error instanceof MemoryServiceError && error.code === "forbidden" || error instanceof ContextError && ["forbidden", "not_found", "conflict"].includes(error.code)) continue; throw error; }
          detailsRead++; const remote = await adapter.read(ref, { signal }); check();
          let record: MemoryRecordReference & { content: string; evidenceRefs: string[] };
          try { record = this.#active(a.botId, ref, epoch); }
          catch (error) { if (error instanceof MemoryServiceError && error.code === "forbidden" || error instanceof ContextError && ["forbidden", "not_found", "conflict"].includes(error.code)) continue; throw error; }
          if (remote.kind === "missing") continue;
          const detail = this.#materialize(record, hit.uri, hit.score); if (!detail) continue;
          const size = Buffer.byteLength(detail.markdown, "utf8"); if (bytes + size > MEMORY_SERVICE_LIMITS.totalBytes) continue;
          output.push(detail); bytes += size; if (output.length === limit) break;
        }
        // Results read earlier in this loop can become stale while a later detail is awaited.
        check(); for (const detail of output) this.#active(a.botId, { recordId: detail.recordId, revision: detail.revision, sha256: detail.sha256 }, epoch);
        check(); return output;
      } catch (error) { check(); throw error;
      } finally { this.#dispose(adapter); }
    });
  }
  /** Trusted host administration ONLY. Does not accept a turn capability and is never published as an engine tool. */
  flushBotProjections(botId: string, limit = MEMORY_SERVICE_LIMITS.projectionBatch): Promise<{ attempted: number; receipts: OpenVikingProjectionReceipt[] }> {
    return this.#run(async signal => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_SERVICE_LIMITS.projectionBatch) throw new MemoryServiceError("invalid_input");
      const identity = this.#identity(botId), epoch = this.#ledger.scopeEpoch({ kind: "bot", botId });
      const check = () => { this.#job(signal); if (this.#ledger.scopeEpoch({ kind: "bot", botId }) !== epoch) throw new MemoryServiceError("revoked"); };
      const durable = this.#ledger.projectionJournal(`ms1_${randomUUID().replaceAll("-", "")}`);
      const journal: OpenVikingProjectionJournal = { claim: async binding => { check(); this.#active(botId, binding, epoch); return durable.claim(binding); },
        record: async receipt => { check(); this.#active(botId, receipt, epoch); await durable.record(receipt); } };
      let adapter: OpenVikingAdapter | undefined;
      try {
        adapter = await this.#adapter(identity, check, signal, journal); check();
        const pending = this.#ledger.listPendingProjections(botId, { limit }).items, receipts: OpenVikingProjectionReceipt[] = [];
        for (const binding of pending) {
          check(); let record: MemoryRecordReference & { content: string; evidenceRefs: string[] };
          try { record = this.#active(botId, binding, epoch); }
          catch (error) { if (error instanceof MemoryServiceError && error.code === "forbidden" || error instanceof ContextError && ["forbidden", "not_found", "conflict"].includes(error.code)) continue; throw error; }
          const receipt = await adapter.project({ operationKey: binding.operationKey, recordId: binding.recordId, revision: binding.revision, sha256: binding.sha256, markdown: record.content }, { signal });
          check(); this.#active(botId, binding, epoch); receipts.push(receipt);
        }
        return { attempted: receipts.length, receipts };
      } catch (error) { check(); throw error;
      } finally { this.#dispose(adapter); }
    });
  }
  stopAdmission(): void { this.#stopping = true; for (const controller of this.#controllers) if (!controller.signal.aborted) controller.abort(new MemoryServiceError("closed")); for (const adapter of this.#adapters) adapter.close(); }
  close(): Promise<void> {
    this.stopAdmission();
    return this.#closing ??= (async () => {
      // A pending reader can add its tracked cancel while an earlier job drains.
      // Stop admission prevents new jobs, but one snapshot is not proof of complete IO drain.
      while (this.#calls.size > 0) await Promise.allSettled([...this.#calls]);
      if (this.#configuration.supervisor) {
        let result: { complete: boolean };
        try { result = await this.#configuration.supervisor.stop(); } catch { throw new MemoryServiceError("cleanup_incomplete", "retry_cleanup"); }
        if (result?.complete !== true) throw new MemoryServiceError("cleanup_incomplete", "retry_cleanup");
      }
      this.#closed = true;
    })();
  }
}
