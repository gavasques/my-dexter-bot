import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { assertOpenVikingBotIdentity, openVikingPrivateMemoryRoot, openVikingRevisionUri, parseOpenVikingRevisionUri,
  validateOpenVikingUserKey, OPENVIKING_UPSTREAM_PIN } from "./openviking-identity.js";
import type { OpenVikingBotIdentity, OpenVikingRevisionRef } from "./openviking-identity.js";
import { OpenVikingError, OpenVikingHttpTransport, openVikingRecord, openVikingResult } from "./openviking-http.js";
import type { OpenVikingCallOptions, OpenVikingErrorCode, OpenVikingHttpOptions } from "./openviking-http.js";

export interface OpenVikingProjectionBinding extends OpenVikingRevisionRef {
  readonly operationKey: string;
  readonly accountId: string;
  readonly userId: string;
  readonly uri: string;
}
export type OpenVikingProjectionOutcome = "confirmed" | "unknown" | "conflict";
export interface OpenVikingProjectionReceipt extends OpenVikingProjectionBinding {
  readonly outcome: OpenVikingProjectionOutcome;
  /** Read-back proves current raw bytes only. Neither ACK, hash nor task ID proves semantic index coverage. */
  readonly indexing: "unproven";
  readonly taskId: string | null;
  readonly reason: OpenVikingErrorCode | "missing" | "hash_mismatch" | "create_unsettled" | "delete_still_present" | null;
}
export interface OpenVikingProjectionJournal {
  /** Atomically validate canonical accepted revision/hash, bind operation key, and durably mark dispatched BEFORE POST.
   * Return send only once. Existing dispatched/unknown bindings return reconcile; mismatches must reject.
   * Host leases/fences govern claims and receipt updates; an in-memory implementation is test-only.
   */
  claim(binding: OpenVikingProjectionBinding): Promise<"send" | "reconcile">;
  /** Persist receipt with current host epoch/fence. Never downgrade a confirmed receipt to a stale unknown. */
  record(receipt: OpenVikingProjectionReceipt): Promise<void>;
}
export interface OpenVikingAdapterOptions extends OpenVikingHttpOptions {
  identity: OpenVikingBotIdentity;
  /** Private host custody closure. No root/admin credential and no impersonation headers. */
  credential: () => string | Promise<string>;
  journal?: OpenVikingProjectionJournal;
}
export interface OpenVikingRecallQuery { query: string; limit?: number }
export interface OpenVikingRecallHit extends OpenVikingRevisionRef {
  uri: string; score: number; contextType: "resource"; level: 2;
}
export interface OpenVikingProjectionInput { operationKey: string; recordId: string; revision: number; markdown: string; sha256: string }
export type OpenVikingRevisionRead = { kind: "missing" } | { kind: "found"; markdown: string; sha256: string };
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function closedKeys(value: unknown, allowed: string[]): Record<string, unknown> {
  const row = openVikingRecord(value);
  if (Object.keys(row).some(key => !allowed.includes(key))) throw new OpenVikingError("input");
  return row;
}

/** Internal host API, not an engine tool. All queries target one technical bot's canonical projection tree. */
export class OpenVikingAdapter {
  readonly identity: OpenVikingBotIdentity;
  readonly #http: OpenVikingHttpTransport;
  readonly #credential: OpenVikingAdapterOptions["credential"];
  readonly #journal: OpenVikingProjectionJournal | undefined;
  #closed = false;
  constructor(options: OpenVikingAdapterOptions) {
    try { assertOpenVikingBotIdentity(options.identity); } catch { throw new OpenVikingError("identity"); }
    if (typeof options.credential !== "function") throw new OpenVikingError("configuration");
    this.identity = options.identity;
    this.#http = new OpenVikingHttpTransport(options);
    this.#credential = options.credential;
    this.#journal = options.journal;
  }
  toJSON(): { backend: "openviking"; upstreamPin: string; accountId: string; userId: string } {
    return { backend: "openviking", upstreamPin: OPENVIKING_UPSTREAM_PIN, accountId: this.identity.accountId, userId: this.identity.userId };
  }
  [inspect.custom](): string { return `OpenVikingAdapter(${this.identity.accountId}, ${this.identity.userId})`; }
  close(): void { this.#closed = true; this.#http.close(); }

  async #key(options: OpenVikingCallOptions): Promise<string> {
    if (this.#closed) throw new OpenVikingError("closed");
    let key: unknown;
    try { key = await this.#credential(); validateOpenVikingUserKey(key, this.identity); }
    catch { throw new OpenVikingError("identity"); }
    const response = await this.#http.request("GET", "/health", key, undefined, options);
    if (response.status !== 200) throw new OpenVikingError("http", response.status);
    const health = openVikingRecord(response.body);
    if (health.status !== "ok" || health.healthy !== true || health.auth_mode !== "api_key" || health.role !== "user" ||
      health.account_id !== this.identity.accountId || health.user_id !== this.identity.userId) throw new OpenVikingError("identity");
    return key; // Same snapshot authenticates health and subsequent calls, including during rotation.
  }

  async status(options: OpenVikingCallOptions = {}): Promise<{ identityVerified: true; content: "unproven"; indexing: "unproven"; upstreamPin: string }> {
    await this.#key(options);
    return { identityVerified: true, content: "unproven", indexing: "unproven", upstreamPin: OPENVIKING_UPSTREAM_PIN };
  }

  async recall(input: OpenVikingRecallQuery, options: OpenVikingCallOptions = {}): Promise<OpenVikingRecallHit[]> {
    const row = closedKeys(input, ["query", "limit"]);
    if (typeof row.query !== "string" || !row.query.trim() || row.query.length > 4096 || Buffer.from(row.query, "utf8").toString("utf8") !== row.query) throw new OpenVikingError("input");
    const limit = row.limit ?? 20;
    const query = row.query;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new OpenVikingError("input");
    const key = await this.#key(options);
    const result = openVikingRecord(openVikingResult(await this.#http.request("POST", "/api/v1/search/find", key,
      { query, target_uri: openVikingPrivateMemoryRoot(this.identity), context_type: "resource", limit, level: 2,
        include_provenance: false, read_content: false, telemetry: false }, options)));
    if (!Array.isArray(result.resources) || !Array.isArray(result.memories) || !Array.isArray(result.skills) ||
      result.memories.length || result.skills.length || result.resources.length > limit || result.total !== result.resources.length) throw new OpenVikingError("protocol");
    const seen = new Set<string>();
    return result.resources.map(raw => {
      const hit = openVikingRecord(raw);
      if (typeof hit.uri !== "string" || hit.context_type !== "resource" || hit.level !== 2 || typeof hit.score !== "number" || !Number.isFinite(hit.score)) throw new OpenVikingError("protocol");
      let ref: OpenVikingRevisionRef;
      try { ref = parseOpenVikingRevisionUri(this.identity, hit.uri); } catch { throw new OpenVikingError("scope"); }
      if (seen.has(hit.uri)) throw new OpenVikingError("protocol");
      seen.add(hit.uri);
      // Do not expose backend abstract/overview/match_reason/text. Host revalidates ledger/epoch before read/injection.
      return { ...ref, uri: hit.uri, score: hit.score, contextType: "resource", level: 2 };
    });
  }

  async #read(key: string, uri: string, options: OpenVikingCallOptions): Promise<OpenVikingRevisionRead> {
    const query = new URLSearchParams({ uri, raw: "true", offset: "0", limit: "-1" });
    const response = await this.#http.request("GET", `/api/v1/content/read?${query}`, key, undefined, options);
    if (response.status === 404) {
      const envelope = openVikingRecord(response.body);
      if (envelope.status === "error" && openVikingRecord(envelope.error).code === "NOT_FOUND") return { kind: "missing" };
      throw new OpenVikingError("protocol");
    }
    const markdown = openVikingResult(response);
    if (typeof markdown !== "string" || Buffer.from(markdown, "utf8").toString("utf8") !== markdown) throw new OpenVikingError("protocol");
    return { kind: "found", markdown, sha256: sha(markdown) };
  }

  async read(ref: OpenVikingRevisionRef, options: OpenVikingCallOptions = {}): Promise<OpenVikingRevisionRead> {
    closedKeys(ref, ["recordId", "revision", "sha256"]);
    const snapshot = { recordId: ref.recordId, revision: ref.revision, sha256: ref.sha256 };
    let uri: string;
    try { uri = openVikingRevisionUri(this.identity, snapshot); } catch { throw new OpenVikingError("input"); }
    const result = await this.#read(await this.#key(options), uri, options);
    if (result.kind === "found" && result.sha256 !== snapshot.sha256) throw new OpenVikingError("protocol");
    return result;
  }

  async project(input: OpenVikingProjectionInput, options: OpenVikingCallOptions = {}): Promise<OpenVikingProjectionReceipt> {
    closedKeys(input, ["operationKey", "recordId", "revision", "markdown", "sha256"]);
    input = Object.freeze({ operationKey: input.operationKey, recordId: input.recordId, revision: input.revision, markdown: input.markdown, sha256: input.sha256 });
    if (!this.#journal) throw new OpenVikingError("configuration");
    if (typeof input.operationKey !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(input.operationKey) || typeof input.markdown !== "string" ||
      !input.markdown || Buffer.byteLength(input.markdown, "utf8") > 131_072 || Buffer.from(input.markdown, "utf8").toString("utf8") !== input.markdown ||
      sha(input.markdown) !== input.sha256) throw new OpenVikingError("input");
    let uri: string;
    try { uri = openVikingRevisionUri(this.identity, input); } catch { throw new OpenVikingError("input"); }
    const binding: OpenVikingProjectionBinding = Object.freeze({ operationKey: input.operationKey, recordId: input.recordId,
      revision: input.revision, sha256: input.sha256, uri, accountId: this.identity.accountId, userId: this.identity.userId });
    const key = await this.#key(options);
    let disposition: "send" | "reconcile";
    try { disposition = await this.#journal.claim(binding); } catch { throw new OpenVikingError("journal"); }
    if (disposition !== "send" && disposition !== "reconcile") throw new OpenVikingError("journal");
    let taskId: string | null = null;
    const finish = async (outcome: OpenVikingProjectionOutcome, reason: OpenVikingProjectionReceipt["reason"]): Promise<OpenVikingProjectionReceipt> => {
      const receipt: OpenVikingProjectionReceipt = Object.freeze({ ...binding, outcome, indexing: "unproven", taskId, reason });
      try { await this.#journal!.record(receipt); } catch { throw new OpenVikingError("journal"); }
      return receipt;
    };
    try {
      const before = await this.#read(key, uri, options);
      if (before.kind === "found") return await finish(before.sha256 === input.sha256 ? "confirmed" : "conflict", before.sha256 === input.sha256 ? null : "hash_mismatch");
      // An absent GET is not proof that an earlier POST cannot still commit. Never resend a dispatched binding.
      if (disposition === "reconcile") return await finish("unknown", "missing");
      const ack = openVikingRecord(openVikingResult(await this.#http.request("POST", "/api/v1/content/write", key,
        { uri, content: input.markdown, mode: "create", wait: false, telemetry: false, processing_mode: "semantic_and_vectors" }, options)));
      if (ack.uri !== uri || ack.mode !== "create" || ack.content_updated !== true || ack.written_bytes !== Buffer.byteLength(input.markdown, "utf8")) throw new OpenVikingError("protocol");
      if (ack.task_id !== undefined) {
        if (typeof ack.task_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(ack.task_id)) throw new OpenVikingError("protocol");
        taskId = ack.task_id;
      }
      const after = await this.#read(key, uri, options);
      if (after.kind === "missing") return await finish("unknown", "missing");
      return await finish(after.sha256 === input.sha256 ? "confirmed" : "conflict", after.sha256 === input.sha256 ? null : "hash_mismatch");
    } catch (error) {
      if (error instanceof OpenVikingError && error.code === "journal") throw error;
      return await finish("unknown", error instanceof OpenVikingError ? error.code : "network");
    }
  }
  /** Missing/expired task is not proof that an uncertain create stopped. */
  async creationSettled(taskId:string|null,options:OpenVikingCallOptions={}):Promise<boolean> {
    if(taskId===null)return false;if(!/^[A-Za-z0-9_-]{1,160}$/.test(taskId))throw new OpenVikingError('input');
    try{const task=openVikingRecord(openVikingResult(await this.#http.request('GET','/api/v1/tasks/'+taskId,await this.#key(options),undefined,options)));return task.task_id===taskId&&['completed','failed','cancelled'].includes(String(task.status));}catch{return false;}
  }
  async purge(input:OpenVikingProjectionBinding&{createSettled:boolean},options:OpenVikingCallOptions={}):Promise<OpenVikingProjectionReceipt> {
    closedKeys(input,['operationKey','accountId','userId','recordId','revision','uri','sha256','createSettled']);const {createSettled,...binding}=input;
    if(binding.accountId!==this.identity.accountId||binding.userId!==this.identity.userId||openVikingRevisionUri(this.identity,binding)!==binding.uri||typeof createSettled!=='boolean'||!this.#journal)throw new OpenVikingError('input');
    const key=await this.#key(options),disposition=await this.#journal.claim(binding);if(!['send','reconcile'].includes(disposition))throw new OpenVikingError('journal');
    const finish=async(outcome:OpenVikingProjectionOutcome,reason:OpenVikingProjectionReceipt['reason'])=>{const receipt:OpenVikingProjectionReceipt={...binding,outcome,indexing:'unproven',taskId:null,reason};await this.#journal!.record(receipt);return receipt;};
    try{const before=await this.#read(key,binding.uri,options);if(!createSettled)return await finish('unknown','create_unsettled');if(before.kind==='missing')return await finish('confirmed',null);if(before.sha256!==binding.sha256)return await finish('conflict','hash_mismatch');if(disposition==='reconcile')return await finish('unknown','delete_still_present');
      const query=new URLSearchParams({uri:binding.uri,recursive:'false',wait:'true',timeout:'10'});
      const response=await this.#http.request('DELETE','/api/v1/fs?'+query,key,undefined,options);if(response.status!==404){const ack=openVikingRecord(openVikingResult(response));if(ack.uri!==binding.uri)throw new OpenVikingError('protocol');}
      const after=await this.#read(key,binding.uri,options);return await finish(after.kind==='missing'?'confirmed':'unknown',after.kind==='missing'?null:'delete_still_present');
    }catch(error){if(error instanceof OpenVikingError&&error.code==='journal')throw error;return await finish('unknown',error instanceof OpenVikingError?error.code:'network');}
  }

}
