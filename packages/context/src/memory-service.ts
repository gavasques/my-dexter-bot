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

export const MEMORY_SERVICE_LIMITS = Object.freeze({ searchCandidates: 20, details: 8, detailBytes: 8192, totalBytes: 32768,
  evidenceRefs: 8, evidenceBytes: 2048, referenceBytes: 512, queryCharacters: 2000, projectionBatch: 20 });
export type MemoryServiceErrorCode = "blocked_configuration" | "forbidden" | "revoked" | "invalid_input" | "not_implemented" | "backend_unavailable" | "deadline" | "closed" | "cleanup_incomplete";
export type MemoryServiceRecoveryCode = "configure_backend" | "provide_bot_user_key" | "configure_identity_binding" | "new_authorized_turn" | "inspect_backend" | "team_memory_pending" | "group_memory_pending" | "retry_cleanup";
/** Values, causes, provider response bodies and credential exceptions never cross this facade. */
export class MemoryServiceError extends Error {
  constructor(readonly code: MemoryServiceErrorCode, readonly recovery: MemoryServiceRecoveryCode | null = null) {
    super(`Memory service ${code}`); this.name = "MemoryServiceError";
  }
}
/** Host-only resolver of a CURRENT Context capability, never accepted from a tool body. */
export interface MemoryServiceAuthority {
  readonly workspaceId: string; readonly botId: string; readonly turnId: string; readonly threadId: string;
  readonly audience: "private" | "team" | "group"; readonly authorizationStamp: string; readonly privateRecallAllowed: boolean;
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

/** Trusted host read lifetime. A response deadline/abort does not settle whenDrained. */
export interface MemoryServiceReadLease<T> {
  readonly result: Promise<T>;
  whenDrained(): Promise<void>;
}
export interface MemoryServiceReadOptions {
  readonly signal?: AbortSignal;
  /** Host capability/grant/turn check, never an argument in an engine schema. */
  readonly guard?: () => void;
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
  #configuration: Readonly<MemoryServiceConfiguration>;
  readonly #calls = new Set<Promise<unknown>>();
  readonly #adapters = new Set<OpenVikingAdapter>();
  readonly #controllers = new Set<AbortController>();
  readonly #deadlines = new WeakMap<AbortSignal, { controller: AbortController; at: number }>();
  readonly #ownedWork = new WeakMap<AbortSignal, Set<Promise<unknown>>>();
  readonly #readGuards = new WeakMap<AbortSignal, () => void>();
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
  /** Trusted local-host bootstrap only. Configures a previously unconfigured, idle facade exactly once.
   * Replacing an admitted backend requires host restart/drain; this method never resurrects a closed service.
   * It is not registered as an engine/MCP operation and cannot grant access or choose another bot identity. */
  configureInitialBackend(input: MemoryServiceConfiguration): void {
    this.#admitted();
    const configuration = snapshotMemoryServiceConfiguration(input);
    if (!configuration.backend || this.#configuration.backend || this.#calls.size || this.#adapters.size)
      throw new MemoryServiceError("blocked_configuration", "configure_backend");
    this.#configuration = configuration;
  }
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
    try { this.#readGuards.get(signal)?.(); }
    catch { throw new MemoryServiceError("revoked", "new_authorized_turn"); }
  }
  #resolve(token: string): Readonly<MemoryServiceAuthority> {
    this.#admitted();
    try {
      const a = this.#authority(token);
      if (a.workspaceId !== this.#mapper.workspaceId || typeof a.botId !== "string" || !a.botId ||
        typeof a.turnId !== "string" || !a.turnId || typeof a.threadId !== "string" || !a.threadId ||
        !["private", "team", "group"].includes(a.audience) || typeof a.privateRecallAllowed !== "boolean" ||
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
    if (a.audience === "group") throw new MemoryServiceError("not_implemented", "group_memory_pending");
    if (a.audience === "team") throw new MemoryServiceError("not_implemented", "team_memory_pending");
    if (!a.privateRecallAllowed) deny();
  }
  /** Host-only current read witness, including private backend generation. Never an engine result. */
  readAuthority(token: string): Readonly<MemoryServiceAuthority> {
    const authority = this.#resolve(token); this.#private(authority); return authority;
  }
  #identity(botId: string): OpenVikingBotIdentity {
    const identity = this.#mapper.bot(botId);
    try {
      // Local deterministic descriptor only. This never provisions remote accounts/users or reads a root/admin key.
      const persisted = (()=>{try{return this.#ledger.subject(botId);}catch{return this.#ledger.provisionBotSubject(botId);}})();
      if (!sameIdentity(identity, persisted)) throw new Error();
    } catch { throw new MemoryServiceError("blocked_configuration", "configure_identity_binding"); }
    return identity;
  }
  #active(botId: string, ref: OpenVikingRevisionRef, epoch: number): MemoryRecordReference & { content: string; evidenceRefs: string[] } {
    const result = this.#ledger.readActiveReference(botId, { ...ref, scopeEpoch: epoch });
    if (result.scope.kind !== "bot" || result.botId !== botId) return deny();
    return result;
  }
  #track<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    const owned = signal ? this.#ownedWork.get(signal) : undefined;
    this.#calls.add(promise); owned?.add(promise);
    const release = () => { this.#calls.delete(promise); owned?.delete(promise); };
    void promise.then(release, release); return promise;
  }
  #response(response: Response, check: () => void, signal: AbortSignal): Response {
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
      }), signal),
      cancel: () => this.#track(Promise.resolve().then(async () => { try { await reader.cancel(); } finally { finish(); } }), signal),
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  #run<T>(work: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    return this.#runOwned(work, externalSignal ? { signal: externalSignal } : {}).result;
  }
  #runOwned<T>(work: (signal: AbortSignal) => Promise<T>, options: MemoryServiceReadOptions = {}): MemoryServiceReadLease<T> {
    try { this.#admitted(); } catch (error) { return { result: Promise.reject(error), whenDrained: async () => {} }; }
    const controller = new AbortController(); this.#controllers.add(controller);
    const owned = new Set<Promise<unknown>>(); this.#ownedWork.set(controller.signal, owned);
    if (options.guard) this.#readGuards.set(controller.signal, options.guard);
    const abort = () => controller.abort(new MemoryServiceError("closed"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
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
        options.signal?.removeEventListener("abort", abort);
      } });
    this.#track(call, controller.signal);
    let draining: Promise<void> | undefined;
    return { result: Promise.race([call, interrupted]), whenDrained: () => draining ??= (async () => {
      // A pending transport/body reader can add tracked work while the earlier closure drains.
      while (owned.size) await Promise.allSettled([...owned]);
      this.#ownedWork.delete(controller.signal); this.#readGuards.delete(controller.signal);
    })() };
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
      const result = await this.#track(Promise.resolve().then(() => { check(); return (backend.fetch ?? fetch)(url, init); }), signal);
      check(); return this.#response(result, check, signal);
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
    return this.beginRead(token, input).result;
  }
  /** Host-only read handle; keep its Context token until this exact job and late IO drain. */
  beginRead(token: string, input: OpenVikingRevisionRef, options: MemoryServiceReadOptions = {}): MemoryServiceReadLease<MemoryServiceMemory | null> {
    return this.#runOwned(async signal => {
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
    }, options);
  }
  recall(token: string, input: { query: string; limit?: number }): Promise<MemoryServiceMemory[]> {
    return this.beginRecall(token, input).result;
  }
  /** Host-only recall handle. No fallback, automatic projection or administrative authority. */
  beginRecall(token: string, input: { query: string; limit?: number }, options: MemoryServiceReadOptions = {}): MemoryServiceReadLease<MemoryServiceMemory[]> {
    return this.#runOwned(async signal => {
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
    }, options);
  }
  /** Trusted host administration ONLY. Does not accept a turn capability and is never published as an engine tool. */
  flushBotProjections(botId: string, limit: number = MEMORY_SERVICE_LIMITS.projectionBatch, options: { signal?: AbortSignal } = {}): Promise<{ attempted: number; receipts: OpenVikingProjectionReceipt[] }> {
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
    }, options.signal);
  }

  flushBotDeletes(botId:string,limit=20,options:{signal?:AbortSignal}={}):Promise<{attempted:number;receipts:OpenVikingProjectionReceipt[]}> {
    return this.#run(async signal=>{if(!Number.isInteger(limit)||limit<1||limit>20)throw new MemoryServiceError('invalid_input');const identity=this.#identity(botId),journal=this.#ledger.deletionJournal('purge_'+randomUUID().replaceAll('-',''));const check=()=>{this.#job(signal);this.#ledger.subject(botId);};let adapter:OpenVikingAdapter|undefined;
      try{adapter=await this.#adapter(identity,check,signal,journal);const receipts:OpenVikingProjectionReceipt[]=[];for(const pending of this.#ledger.listPendingDeletes(botId,limit)){check();const createSettled=pending.createFence===0||pending.createConfirmed&&pending.createLeaseUntil===null&&await adapter.creationSettled(pending.createTaskId,{signal});check();if(!createSettled)continue;const binding={operationKey:pending.operationKey,accountId:pending.accountId,userId:pending.userId,recordId:pending.recordId,revision:pending.revision,uri:pending.uri,sha256:pending.sha256};receipts.push(await adapter.purge({...binding,createSettled},{signal}));check();}return {attempted:receipts.length,receipts};}finally{this.#dispose(adapter);}
    }, options.signal);
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
