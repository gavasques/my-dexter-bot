import { MemoryBackendStore, MEMORY_BACKEND_SQL, MEMORY_BACKEND_TABLES, assertMemoryBackendSchema } from './memory-backend-store.js';
import { groupAudienceForTurn } from "./group-audience.js";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HostStore } from "@dexter/hub";
import type { BotDelegation, CreateTeam, PatchTeam, Team, TeamThread } from "@dexter/contracts";
import { rejectSymlink } from "./filesystem.js";
import { ContextRepository, sha256 } from "./repository.js";
import { BotDocumentStore, BOT_DOCUMENT_HISTORY_SQL } from "./bot-documents.js";
import { MemoryRoutineStore } from "./memory-routine-store.js";
import { MemoryLedgerStore, MEMORY_LEDGER_SQL, MEMORY_LEDGER_TABLES, assertMemoryLedgerSchema } from './memory-ledger.js';
import { MemoryLearningStore } from './memory-learning.js';
import { MEMORY_LEARNING_SQL, MEMORY_LEARNING_TABLES, assertMemoryLearningSchema } from './memory-learning-schema.js';
import type { RestoreBotMemory } from "@dexter/contracts";
import { ContextTeams } from "./teams.js";
import { turnMemoryScopes } from "./memory-policy.js";
import {
  ContextError, id, locale, scope, scopeKey, text, type Artifact, type ArtifactRevision, type ContextHostOptions, type ContextScope,
  type MemoryAdapter, type MemoryInput, type MemoryPage, type RecallInput, type ServiceHit, type ServiceScope, type SkillLock, type SkillCatalogQuery, type SkillCatalogPage, type SkillVersion, type SkillActivationQuery, type SkillActivationPage, type SkillActivationExpected, type SkillActivation, type BotDocuments, type SetBotDocuments,
} from "./types.js";

type Row = Record<string, unknown>;
interface Principal { turnId: string; botId: string; profileId: string; threadId: string; ownerId: string; installationId: string; expiresAt?: number }
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE teams (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE members (team_id TEXT NOT NULL, owner_id TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(team_id, owner_id));
CREATE TABLE team_bots (team_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY(team_id, bot_id));
CREATE TABLE recall_grants (bot_id TEXT NOT NULL, scope_key TEXT NOT NULL, allowed INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(bot_id, scope_key));
CREATE TABLE memories (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, locale TEXT NOT NULL, origin TEXT NOT NULL,
  active INTEGER NOT NULL, workspace TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, git_commit TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE promotions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_json TEXT NOT NULL, proposer_bot TEXT NOT NULL,
  request_hash TEXT NOT NULL, state TEXT NOT NULL, promoted_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE skills (id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, git_commit TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(id, version));
CREATE TABLE activations (scope_key TEXT NOT NULL, skill_id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY(scope_key, skill_id));
CREATE TABLE artifacts (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, head INTEGER NOT NULL, fork_id TEXT, fork_revision INTEGER);
CREATE TABLE revisions (artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, git_commit TEXT NOT NULL, path TEXT NOT NULL,
  origin TEXT NOT NULL, created_at INTEGER NOT NULL, restored_from INTEGER, PRIMARY KEY(artifact_id, revision));
`;

/** Trusted host service. Administration methods must never be published directly as engine tools. */
export class ContextHost {
  readonly databasePath: string;
  readonly repositoryPath: string;
  private readonly db: DatabaseSync;
  private readonly repository: ContextRepository;
  private readonly teams: ContextTeams;
  private readonly documents: BotDocumentStore;
  readonly memoryRoutines: MemoryRoutineStore;
  /** Internal trusted-host administration. This facade is never a model/engine tool. */
  readonly memoryLedger: MemoryLedgerStore;
  readonly memoryLearning: MemoryLearningStore;
  readonly memoryBackend: MemoryBackendStore;
  private writeDepth = 0;
  private readonly capabilities = new Map<string, Principal>();
  private closed = false;
  private readonly capabilityTTLms: number;
  constructor(private readonly store: HostStore, private readonly adapter: MemoryAdapter, options: ContextHostOptions = {}) {
    this.capabilityTTLms = options.capabilityTTLms ?? 15 * 60_000;
    if (!Number.isInteger(this.capabilityTTLms) || this.capabilityTTLms < 1 || this.capabilityTTLms > 86_400_000) throw new ContextError("invalid_input");
    if (adapter.targetVersion !== "2.5.2") throw new ContextError("invalid_input");
    this.databasePath = join(dirname(store.databasePath), "context.sqlite");
    this.repositoryPath = join(dirname(store.databasePath), "context-revisions");
    const opened = store.withMemoryExtensionLease(() => {
      for (const file of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
        rejectSymlink(file);
      }
      const db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
      try {
        db.exec("BEGIN IMMEDIATE");
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
        if (!exists) {
          db.exec(SCHEMA);
          const put = db.prepare("INSERT INTO meta (key,value) VALUES (?,?)");
          put.run("schema", "1"); put.run("installation", store.hostId); put.run("owner", store.ownerId);
        }
        const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row | undefined)?.value;
        if (!["1", "2", "3", "4", "5"].includes(get("schema") as string) || get("installation") !== store.hostId || get("owner") !== store.ownerId) throw new ContextError("conflict", "context belongs to another installation or owner");
        // Check the schema2 tables before legacy additive migration; never silently recreate a missing canonical index.
        if (["2","3","4","5"].includes(get("schema") as string)) for (const name of ["bot_documents","bot_document_revisions","bot_document_receipts"])
          if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new ContextError("tampered");
        // Additive migration only after the canonical installation/owner has been checked.
        db.exec(`CREATE TABLE IF NOT EXISTS bot_documents (bot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
          soul_pin_json TEXT NOT NULL, user_pin_json TEXT NOT NULL, memory_pin_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
        if (get("schema") === "1") {
          db.exec(BOT_DOCUMENT_HISTORY_SQL);
          // Legacy head only: do not enumerate Git or invent missing historical revisions or exact receipts.
          db.exec(`INSERT INTO bot_document_revisions SELECT bot_id,revision,soul_pin_json,user_pin_json,memory_pin_json,
            '{"kind":"legacy_unknown","reference":null}',NULL,updated_at FROM bot_documents`);
          db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run();
        }
        if (get('schema') === '2') {
          // A partial/unmarked ledger is corruption, never a reason to reconstruct or reset history.
          for (const name of MEMORY_LEDGER_TABLES) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new ContextError('tampered');
          db.exec(MEMORY_LEDGER_SQL);
          db.prepare("UPDATE meta SET value='3' WHERE key='schema'").run();
        } else {
          for (const name of MEMORY_LEDGER_TABLES) if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new ContextError('tampered');
        }
        assertMemoryLedgerSchema(db);
        if (get('schema') === '3') {
          for (const name of MEMORY_LEARNING_TABLES) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new ContextError('tampered');
          db.exec(MEMORY_LEARNING_SQL); db.prepare("UPDATE meta SET value='4' WHERE key='schema'").run();
        }
        assertMemoryLearningSchema(db);
        if (get('schema') === '4') {
          for (const name of MEMORY_BACKEND_TABLES) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new ContextError('tampered');
          db.exec(MEMORY_BACKEND_SQL); db.prepare("UPDATE meta SET value='5' WHERE key='schema'").run();
        }
        assertMemoryBackendSchema(db);
        // A fresh Context handle owns no prior model dispatch. Do not wait for/reclaim its old lease.
        db.prepare("UPDATE memory_learning_jobs SET state='unknown',lease_owner=NULL,lease_until=NULL,fence=fence+1,updated_at=? WHERE state='dispatched'").run(store.now());
        db.prepare("UPDATE memory_learning_jobs SET state='queued',lease_owner=NULL,lease_until=NULL,fence=fence+1,updated_at=? WHERE state='claimed'").run(store.now());
        db.exec("COMMIT");
        chmodSync(this.databasePath, 0o600);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        const repository = new ContextRepository(this.repositoryPath);
        return { db, repository };
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already committed */ } db.close(); throw error; }
    });
    this.db = opened.db; this.repository = opened.repository;
    this.documents = new BotDocumentStore(this.db,this.repository,store,operation => this.write(operation));
    this.teams = new ContextTeams(store, this.db, operation => this.write(operation));
    this.memoryRoutines = new MemoryRoutineStore(this.db,store,{read:botId=>this.documents.read(botId),receipt:(botId,key,threadId)=>this.documents.receipt(botId,key,threadId)},operation=>this.write(operation),turnId=>this.isPrivateMemoryTurn(turnId));
    this.memoryLedger = new MemoryLedgerStore(this.db,store,operation=>this.write(operation),options.memoryIdentityMapper);
    this.memoryBackend = new MemoryBackendStore(this.db,store,operation=>this.write(operation));
    this.memoryLearning = new MemoryLearningStore(this.db,store,this.memoryLedger,operation=>this.write(operation),turnId=>this.isPrivateMemoryTurn(turnId));
  }
  close(): void {
    if (this.closed) return;
    this.store.withMemoryExtensionLease(() => { this.db.close(); this.closed = true; this.capabilities.clear(); });
  }
  status(): { backend: MemoryAdapter["implementation"]; targetVersion: "2.5.2"; integration: "fixture" | "transport_injected" | "unconfigured"; activeCapabilities: number } {
    if (!this.closed) this.store.withMemoryExtensionLease(() => this.pruneCapabilities());
    return { activeCapabilities: this.capabilities.size, backend: this.adapter.implementation, targetVersion: "2.5.2", integration: this.adapter.implementation === "unconfigured" ? "unconfigured" : this.adapter.implementation === "fixture" ? "fixture" : "transport_injected" };
  }
  private write<T>(operation: () => T): T {
    if (this.closed) throw new ContextError("conflict");
    return this.store.withMemoryExtensionLease(() => {
      for (const file of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) rejectSymlink(file);
      if(this.writeDepth>0)return operation();
      this.db.exec("BEGIN IMMEDIATE"); this.writeDepth++;
      try { const result = operation(); this.db.exec("COMMIT"); return result; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
      finally { this.writeDepth--; }
    });
  }
  private one(sql: string, ...args: Array<string | number>): Row | undefined {
    if (this.closed) throw new ContextError("conflict"); return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: Array<string | number>): Row[] {
    if (this.closed) throw new ContextError("conflict"); return this.db.prepare(sql).all(...args) as Row[];
  }
  private ownedBot(botId: string) {
    const bot = this.store.getBot(id(botId));
    if (bot.ownerId !== this.store.ownerId) throw new ContextError("forbidden"); return bot;
  }
  readBotDocuments(botId: string): BotDocuments { return this.store.withMemoryExtensionLease(() => this.documents.read(botId)); }
  compareAndSetBotDocuments(botId: string, input: SetBotDocuments): BotDocuments { return this.documents.update(botId,input); }
  botMemoryHistory(botId: string, query: {limit?:number;before?:string} = {}) { return this.store.withMemoryExtensionLease(() => this.documents.history(botId,query)); }
  readBotMemoryRevision(botId: string, revision: number) { return this.store.withMemoryExtensionLease(() => this.documents.readRevision(botId,revision)); }
  restoreBotMemory(botId: string, input: RestoreBotMemory): BotDocuments { return this.documents.restore(botId,input); }
  botDocumentReceipt(botId: string, key: string, threadId?: string) { return this.store.withMemoryExtensionLease(() => this.documents.receipt(botId,key,threadId)); }
  /** Includes exact-owner MEMORY note append; only the persisted action supplies the mutation and identity. */
  executeDocumentAction(actionId: string): BotDocuments {
    // Synchronous host-derived lineage/epoch guard; no await or second MEMORY writer. Exact receipt
    // replay is admitted before current policy/CAS, while a stale routine can never create a new effect.
    this.memoryRoutines.guardDocumentAction(actionId);
    return this.documents.executeAction(actionId);
  }
  /** Own-conversation receipt read with a live Context capability. It never claims or re-executes an action. */
  memoryNoteReceipt(token: string, actionId: string): BotDocuments | null {
    return this.store.withMemoryExtensionLease(() => {
      const principal=this.principal(token),action=this.store.getAction(id(actionId));
      if(action.request.botId!==principal.botId||action.request.threadId!==principal.threadId||action.request.tool!=='dexter.harness.memory.append')throw new ContextError('forbidden');
      return this.documents.receipt(principal.botId,`action:${action.id}`,principal.threadId);
    });
  }
  /** Live turn identity only; the immutable engine snapshot remains pinned until the next turn. */
  botDocuments(token: string): BotDocuments { return this.store.withMemoryExtensionLease(() => {
    const principal = this.principal(token);
    if (!this.isPrivateMemoryTurn(principal.turnId)) throw new ContextError("forbidden");
    return this.documents.read(principal.botId);
  }); }
  /** Existing Context rows are the canonical local registry; profiles never grant bot capabilities. */
  createTeamWorkspace(input: CreateTeam): Team { return this.teams.create(input); }
  listTeamWorkspaces(): Team[] { return this.teams.list(); }
  getTeamWorkspace(teamId: string): Team { return this.teams.get(teamId); }
  updateTeamWorkspace(teamId: string, input: PatchTeam): Team { return this.teams.update(teamId,input); }
  teamForThread(threadId: string): Team | null { return this.teams.threadTeam(threadId); }
  teamScopeForTurn(turnId: string): Team | null { return this.teams.turnTeam(turnId); }
  assertTeamTurn(turnId: string): void { this.teams.assertTurn(turnId); }
  filterTeamPeers<T extends {id:string}>(turnId: string, peers: T[]): T[] { return this.teams.filterPeers(turnId,peers); }
  assertTeamDelegation(sourceTurnId: string, targetBotId: string): void { this.teams.assertDelegation(sourceTurnId,targetBotId); }
  bindTeamThread(teamId: string, threadId: string, expectedRevision: number, clientRequestId: string): TeamThread {
    return this.teams.bindThread(teamId,threadId,expectedRevision,clientRequestId);
  }
  listTeamThreads(teamId: string): TeamThread[] { return this.teams.listThreads(teamId); }
  findTeamThreadReceipt(teamId: string, clientRequestId: string, expectedRevision: number): TeamThread | null {
    return this.teams.findThreadReceipt(teamId,clientRequestId,expectedRevision);
  }
  bindTeamDelegation(teamId: string, delegation: BotDelegation): TeamThread { return this.teams.bindDelegation(teamId,delegation); }
  /** Historical administration APIs remain available over the same canonical identities. */
  createTeam(name: string): string {
    return this.teams.createLegacy(name);
  }
  setMember(teamId: string, memberOwnerId: string, active: boolean): void {
    this.teams.setMemberLegacy(teamId,memberOwnerId,active);
  }
  assignBot(teamId: string, botId: string): void {
    this.teams.assignLegacy(teamId,botId);
  }
  private requireTeam(teamId: string): void {
    if (this.one("SELECT owner_id FROM teams WHERE id=?", id(teamId))?.owner_id !== this.store.ownerId) throw new ContextError("forbidden");
  }
  private requireScope(value: ContextScope): ContextScope {
    const target = scope(value);
    if (target.kind === "team") this.requireTeam(target.teamId);
    else if (target.kind !== "global") this.ownedBot(target.botId);
    return target;
  }
  setRecallGrant(botId: string, value: ContextScope, allowed: boolean): void {
    this.write(() => {
      this.ownedBot(botId); const target = this.requireScope(value);
      this.db.prepare(`INSERT INTO recall_grants VALUES (?,?,?,1) ON CONFLICT(bot_id,scope_key)
        DO UPDATE SET allowed=excluded.allowed,revision=revision+1`).run(botId, scopeKey(target), allowed ? 1 : 0);
    });
  }
  /** Host-issued bearer bound to a currently running turn; neither bot nor owner comes from engine arguments. */
  issue(turnId: string): string {
    return this.store.withMemoryExtensionLease(() => {
      if (this.closed) throw new ContextError("conflict");
      this.pruneCapabilities();
      const turn = this.store.getTurn(id(turnId)); const bot = this.ownedBot(turn.botId);
      if (turn.state !== "running") throw new ContextError("forbidden");
      if ([...this.capabilities.values()].some(principal => principal.turnId === turn.id)) throw new ContextError("conflict");
      const token = randomBytes(32).toString("hex");
      this.capabilities.set(sha256(token), { turnId: turn.id, threadId: turn.threadId, botId: bot.id, profileId: bot.profileId, ownerId: bot.ownerId, installationId: this.store.hostId, expiresAt: this.store.now() + this.capabilityTTLms });
      return token;
    });
  }
  revoke(token: string): void {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new ContextError("invalid_input");
    this.store.withMemoryExtensionLease(() => { this.pruneCapabilities(); this.capabilities.delete(sha256(token)); });
  }
  /** Called only under the host writer fence; terminal/expired capabilities cannot accumulate. */
  private pruneCapabilities(): void {
    const now = this.store.now();
    for (const [hash, principal] of this.capabilities) {
      let live = false;
      try {
        const turn = this.store.getTurn(principal.turnId); const bot = this.ownedBot(principal.botId);
        live = principal.expiresAt !== undefined && principal.expiresAt > now && turn.state === "running"
          && turn.threadId === principal.threadId && turn.botId === principal.botId && bot.profileId === principal.profileId;
      } catch { /* deleted or unavailable principal is dead */ }
      if (!live) this.capabilities.delete(hash);
    }
  }
  private principal(token: string): Principal {
    if (this.closed || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new ContextError("forbidden");
    const principal = this.capabilities.get(sha256(token));
    if (!principal || principal.expiresAt === undefined || principal.expiresAt <= this.store.now() || principal.ownerId !== this.store.ownerId || principal.installationId !== this.store.hostId) throw new ContextError("forbidden");
    const turn = this.store.getTurn(principal.turnId); const bot = this.ownedBot(principal.botId);
    if (turn.state !== "running" || turn.threadId !== principal.threadId || turn.botId !== principal.botId || bot.profileId !== principal.profileId) throw new ContextError("forbidden");
    this.assertTeamTurn(principal.turnId);
    return principal;
  }
  private ownedScopes(principal: Principal, confidential = false): ContextScope[] {
    // Empty turnId is used only by the trusted approval recheck, never by a capability.
    if (principal.turnId && groupAudienceForTurn(this.store, principal.turnId)) return [];
    const team = principal.turnId ? this.teamScopeForTurn(principal.turnId) : null;
    return turnMemoryScopes(principal.botId, team?.id ?? null, confidential);
  }
  /** Host-only audience decision. Revoked/invalid team turns fail; they never become private fallbacks. */
  isPrivateMemoryTurn(turnId: string): boolean {
    this.assertTeamTurn(turnId);
    return groupAudienceForTurn(this.store,turnId) === null && this.teamScopeForTurn(turnId) === null;
  }
  /** Readonly host catalogue/admission witness. Does not mint/share a Context bearer or start IO. */
  privateMemoryReadPolicy(turnId: string): { privateRecallAllowed: boolean; authorizationStamp: string } {
    this.store.assertActiveWriter();
    if (this.closed) throw new ContextError("forbidden");
    const turn = this.store.getTurn(id(turnId)), bot = this.ownedBot(turn.botId);
    if (turn.state !== "running") throw new ContextError("forbidden");
    const principal: Principal = { turnId: turn.id, threadId: turn.threadId, botId: bot.id,
      profileId: bot.profileId, ownerId: bot.ownerId, installationId: this.store.hostId };
    const privateTurn = this.isPrivateMemoryTurn(turn.id);
    return { privateRecallAllowed: privateTurn && this.available(principal).some(value => value.kind === "bot" && value.botId === bot.id),
      authorizationStamp: this.authorizationStamp(principal) };
  }
  /** Trusted internal adapter context, issued only from this host's live turn capability. */
  memoryServiceAuthority(token: string): { workspaceId: string; botId: string; turnId: string; threadId: string;
    audience: "private" | "team" | "group"; authorizationStamp: string; privateRecallAllowed: boolean } {
    return this.store.withMemoryExtensionLease(() => {
      const principal = this.principal(token);
      const privateTurn = this.isPrivateMemoryTurn(principal.turnId);
      return { workspaceId: this.store.hostId, botId: principal.botId, turnId: principal.turnId, threadId: principal.threadId,
        audience: groupAudienceForTurn(this.store,principal.turnId) ? "group" : privateTurn ? "private" : "team", authorizationStamp: this.authorizationStamp(principal),
        privateRecallAllowed: privateTurn && this.available(principal).some(value => value.kind === "bot" && value.botId === principal.botId) };
    });
  }
  private available(principal: Principal, confidential = false): ContextScope[] {
    return this.ownedScopes(principal, confidential).filter(value => this.one("SELECT allowed FROM recall_grants WHERE bot_id=? AND scope_key=?", principal.botId, scopeKey(value))?.allowed !== 0);
  }
  private authorizationStamp(principal: Principal, confidential = false): string {
    return JSON.stringify({ groupAudience: principal.turnId ? groupAudienceForTurn(this.store,principal.turnId) : null, scopes: this.available(principal, confidential).map(scopeKey).sort(),
      grants: this.all("SELECT scope_key,allowed,revision FROM recall_grants WHERE bot_id=? ORDER BY scope_key", principal.botId),
      members: this.all("SELECT m.team_id,m.active,m.revision FROM members m JOIN team_bots tb ON tb.team_id=m.team_id WHERE tb.bot_id=? AND m.owner_id=? ORDER BY m.team_id", principal.botId, principal.ownerId) });
  }
  private mayRead(principal: Principal, value: ContextScope, confidential = false): boolean {
    return this.available(principal, confidential).some(s => scopeKey(s) === scopeKey(value));
  }
  /**
   * Owner-global is global across this owner's bots, never upstream global: it maps to the nonreserved project
   * `owner-global` because v2.5.2 forces any project named `_global`/`scratch` Open to all users. Rows created before
   * this mapping keep their stored `_global` location; they are never recalled through the index or re-pointed.
   */
  private service(value: ContextScope): ServiceScope {
    const namespace = `dx-${sha256(`${this.store.hostId}/${this.store.ownerId}`).slice(0, 24)}`;
    if (value.kind === "global") return { workspace: `${namespace}-global`, project: "owner-global" };
    if (value.kind === "team") return { workspace: `${namespace}-${value.teamId}`, project: "_team" };
    return { workspace: namespace, project: `${value.kind}-${value.botId}` };
  }
  private addMemory(input: MemoryInput): MemoryPage {
    if (input.classification !== "context") throw new ContextError("forbidden", "secrets and health data are outside context capture");
    const target = this.requireScope(input.scope); const language = locale(input.locale); const origin = text(input.origin, 512); const markdown = text(input.markdown); const pageId = `mem_${randomUUID()}`;
    const pin = this.repository.write(`memory/${pageId}/page.md`, markdown);
    const service = { ...this.service(target), path: `notes/${pageId}.md` };
    const now = this.store.now();
    this.db.prepare("INSERT INTO memories VALUES (?,?,?,?,1,?,?,?,?,?,?)").run(pageId, JSON.stringify(target), language, origin, service.workspace, service.project, pin.path, pin.sha256, pin.commit, now);
    return this.memory(this.one("SELECT * FROM memories WHERE id=?", pageId)!);
  }
  /** Explicit trusted owner write. No automatic transcripts, observations, health or secret ingestion. */
  createMemory(input: MemoryInput): MemoryPage { return this.write(() => this.addMemory(input)); }
  /**
   * Trusted owner-only read for the host ai-memory outbox: currently active canonical pages, Git-hash verified,
   * in registry order (keyset `after`) or by explicit `ids`. Inactive/unknown ids are omitted. Never publish to engines.
   */
  activeMemoryPagesForSync(query: { ids?: readonly string[]; after?: string; limit?: number } = {}): MemoryPage[] {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ContextError("invalid_input");
    if (query.ids !== undefined) {
      if (!Array.isArray(query.ids) || query.ids.length > limit || query.after !== undefined) throw new ContextError("invalid_input");
      return query.ids.map(id).flatMap(pageId => { const row = this.one("SELECT * FROM memories WHERE id=? AND active=1", pageId); return row ? [this.memory(row)] : []; });
    }
    if (query.after === undefined) return this.all("SELECT * FROM memories WHERE active=1 ORDER BY rowid LIMIT ?", limit).map(row => this.memory(row));
    if (!this.one("SELECT id FROM memories WHERE id=?", id(query.after))) throw new ContextError("not_found");
    return this.all("SELECT * FROM memories WHERE active=1 AND rowid > (SELECT rowid FROM memories WHERE id=?) ORDER BY rowid LIMIT ?", query.after, limit).map(row => this.memory(row));
  }
  private memory(row: Row): MemoryPage {
    return { id: row.id as string, scope: JSON.parse(row.scope_json as string) as ContextScope, locale: row.locale as MemoryPage["locale"],
      markdown: this.repository.read({ path: row.path as string, sha256: row.hash as string, commit: row.git_commit as string }), origin: row.origin as string,
      classification: "context", active: row.active === 1, service: { workspace: row.workspace as string, project: row.project as string, path: `notes/${row.id as string}.md` }, createdAt: row.created_at as number };
  }
  async recall(token: string, input: RecallInput): Promise<MemoryPage[]> {
    if (!input || Object.keys(input).some(key => !["query", "locale", "includeConfidential", "limit"].includes(key))) throw new ContextError("invalid_input");
    const principal = this.principal(token); text(input.query, 2_000); locale(input.locale);
    if (input.includeConfidential !== undefined && typeof input.includeConfidential !== "boolean") throw new ContextError("invalid_input");
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ContextError("invalid_input");
    const targets = this.available(principal, input.includeConfidential);
    if (targets.length === 0) return [];
    if (this.adapter.implementation === "unconfigured") throw new ContextError("adapter_failed");
    if (targets.length > 25) throw new ContextError("invalid_input");
    const stamp = this.authorizationStamp(principal, input.includeConfidential);
    let hits: readonly ServiceHit[];
    try { hits = await this.adapter.search({ query: input.query, locale: input.locale, scopes: targets.map(s => this.service(s)), limit }); }
    catch { throw new ContextError("adapter_failed"); }
    const refreshed = this.principal(token);
    if (this.authorizationStamp(refreshed, input.includeConfidential) !== stamp) throw new ContextError("forbidden");
    if (!Array.isArray(hits) || hits.length > 100) throw new ContextError("adapter_failed");
    const pages: MemoryPage[] = []; const seen = new Set<string>();
    for (const hit of hits) {
      if (!hit || typeof hit.workspace !== "string" || typeof hit.project !== "string" || typeof hit.path !== "string" || !/^notes\/[A-Za-z0-9_-]+\.md$/.test(hit.path)) continue;
      const pageId = hit.path.slice(6, -3);
      const row = this.one("SELECT * FROM memories WHERE id=? AND workspace=? AND project=? AND active=1 AND locale=?", pageId, hit.workspace, hit.project, input.locale);
      if (!row || seen.has(pageId)) continue;
      const pageScope = JSON.parse(row.scope_json as string) as ContextScope;
      if (!this.mayRead(refreshed, pageScope, input.includeConfidential)) continue;
      pages.push(this.memory(row)); seen.add(pageId);
      if (pages.length >= limit) break;
    }
    return pages;
  }
  proposePromotion(token: string, sourceId: string, target: ContextScope): { id: string; requestHash: string } {
    return this.write(() => {
      const principal = this.principal(token); const row = this.one("SELECT * FROM memories WHERE id=? AND active=1", id(sourceId));
      if (!row) throw new ContextError("not_found");
      const source = this.memory(row); const destination = this.requireScope(target);
      if (source.scope.kind === "confidential" || !this.mayRead(principal, source.scope) || !this.mayRead(principal, destination) || scopeKey(source.scope) === scopeKey(destination)) throw new ContextError("forbidden");
      const proposalId = `promotion_${randomUUID()}`;
      const requestHash = sha256(JSON.stringify({ source: source.id, contentHash: row.hash, target: destination, botId: principal.botId }));
      this.db.prepare("INSERT INTO promotions VALUES (?,?,?,?,?,'pending',NULL,?)").run(proposalId, source.id, JSON.stringify(destination), principal.botId, requestHash, this.store.now());
      return { id: proposalId, requestHash };
    });
  }
  approvePromotion(proposalId: string, requestHash: string): MemoryPage {
    return this.write(() => {
      const proposal = this.one("SELECT * FROM promotions WHERE id=?", id(proposalId));
      if (!proposal || proposal.state !== "pending" || proposal.request_hash !== requestHash) throw new ContextError("conflict");
      const sourceRow = this.one("SELECT * FROM memories WHERE id=? AND active=1", proposal.source_id as string);
      if (!sourceRow) throw new ContextError("conflict");
      const source = this.memory(sourceRow); const target = JSON.parse(proposal.target_json as string) as ContextScope;
      const bot = this.ownedBot(proposal.proposer_bot as string);
      const principal: Principal = { botId: bot.id, ownerId: bot.ownerId, profileId: bot.profileId, threadId: "", turnId: "", installationId: this.store.hostId };
      if (!this.mayRead(principal, source.scope) || !this.mayRead(principal, target)) throw new ContextError("forbidden");
      const page = this.addMemory({ scope: target, locale: source.locale, markdown: source.markdown, origin: `promotion:${proposal.id as string}:${source.id}`, classification: "context" });
      this.db.prepare("UPDATE promotions SET state='applied',promoted_id=? WHERE id=?").run(page.id, proposalId);
      return page;
    });
  }
  reversePromotion(proposalId: string): void {
    this.write(() => {
      const proposal = this.one("SELECT * FROM promotions WHERE id=?", id(proposalId));
      if (!proposal || proposal.state !== "applied") throw new ContextError("conflict");
      this.db.prepare("UPDATE memories SET active=0 WHERE id=?").run(proposal.promoted_id as string);
      this.db.prepare("UPDATE promotions SET state='reversed' WHERE id=?").run(proposalId);
    });
  }
  /** Trusted owner catalog, including inactive versions. No running-turn capability is accepted or issued. */
  listSkillCatalog(input: SkillCatalogQuery = {}): SkillCatalogPage {
    return this.store.withMemoryExtensionLease(() => {
      const limit = this.skillPageLimit(input.limit);
      const skillId = input.skillId === undefined ? null : id(input.skillId);
      let afterId = "", afterVersion = "";
      if (input.after !== undefined) {
        if (typeof input.after !== "string" || input.after.length > 194) throw new ContextError("invalid_input");
        const cursor = input.after.split("|");
        if (cursor.length !== 2) throw new ContextError("invalid_input");
        afterId = id(cursor[0]); afterVersion = this.skillVersion(cursor[1]);
        if (skillId !== null && afterId !== skillId) throw new ContextError("invalid_input");
      }
      const rows = skillId === null
        ? this.all("SELECT * FROM skills WHERE id > ? OR (id = ? AND version > ?) ORDER BY id, version LIMIT ?", afterId, afterId, afterVersion, limit + 1)
        : this.all("SELECT * FROM skills WHERE id = ? AND version > ? ORDER BY version LIMIT ?", skillId, afterVersion, limit + 1);
      const items = rows.slice(0, limit).map(row => this.skill(row.id as string, row.version as string));
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? `${last.id}|${last.version}` : null };
    });
  }
  /** Full Markdown is returned only through the trusted owner administration seam. */
  readSkillVersion(skillId: string, version: string): SkillVersion {
    return this.store.withMemoryExtensionLease(() => {
      const lock = this.skill(id(skillId), this.skillVersion(version));
      return { ...lock, markdown: this.repository.read(lock) };
    });
  }
  /** Explicit locks of exactly one authorized owner scope, not a bot's effective merged selection. */
  listSkillActivations(value: ContextScope, input: SkillActivationQuery = {}): SkillActivationPage {
    return this.store.withMemoryExtensionLease(() => {
      const target = this.requireScope(value);
      if (target.kind === "confidential") throw new ContextError("forbidden");
      const limit = this.skillPageLimit(input.limit);
      const after = input.after === undefined ? "" : id(input.after);
      const rows = this.all("SELECT * FROM activations WHERE scope_key=? AND skill_id>? ORDER BY skill_id LIMIT ?", scopeKey(target), after, limit + 1);
      const items = rows.slice(0, limit).map(row => {
        const lock = this.skill(row.skill_id as string, row.version as string);
        if (lock.sha256 !== row.hash) throw new ContextError("tampered");
        this.repository.read(lock);
        return lock;
      });
      return { scope: target, items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
    });
  }
  private skillPageLimit(value: number | undefined): number {
    const limit = value === undefined ? 50 : value;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ContextError("invalid_input");
    return limit;
  }
  private skillVersion(value: unknown): string {
    if (typeof value !== "string" || value.length > 64 || !/^\d+\.\d+\.\d+$/.test(value)) throw new ContextError("invalid_input");
    return value;
  }
  /** Owner CAS: changing a scope's explicit lock never grants recall or tool permissions. */
  compareAndSetSkillActivation(value: ContextScope, skillId: string, expected: SkillActivationExpected | null, nextVersion: string | null): SkillActivation {
    return this.write(() => {
      const target = this.requireScope(value);
      if (target.kind === "confidential") throw new ContextError("forbidden");
      const key = id(skillId);
      if (expected !== null) {
        if (!expected || typeof expected !== "object" || Object.keys(expected).some(field => !["version", "sha256"].includes(field))) throw new ContextError("invalid_input");
        this.skillVersion(expected.version);
        if (typeof expected.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(expected.sha256)) throw new ContextError("invalid_input");
      }
      if (nextVersion !== null) this.skillVersion(nextVersion);
      const row = this.one("SELECT * FROM activations WHERE scope_key=? AND skill_id=?", scopeKey(target), key);
      if (row) {
        const current = this.skill(key, row.version as string);
        if (current.sha256 !== row.hash) throw new ContextError("tampered");
        if (expected === null || expected.version !== current.version || expected.sha256 !== current.sha256) throw new ContextError("conflict");
      } else if (expected !== null) throw new ContextError("conflict");
      let lock: SkillLock | null = null;
      if (nextVersion === null) {
        this.db.prepare("DELETE FROM activations WHERE scope_key=? AND skill_id=?").run(scopeKey(target), key);
      } else {
        lock = this.skill(key, nextVersion);
        this.repository.read(lock);
        this.db.prepare("INSERT INTO activations VALUES (?,?,?,?) ON CONFLICT(scope_key,skill_id) DO UPDATE SET version=excluded.version,hash=excluded.hash").run(scopeKey(target), lock.id, lock.version, lock.sha256);
      }
      return { scope: target, skillId: key, lock };
    });
  }
  registerSkill(skillId: string, version: string, markdown: string): SkillLock {
    return this.write(() => {
      id(skillId); if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ContextError("invalid_input");
      if (this.one("SELECT id FROM skills WHERE id=? AND version=?", skillId, version)) throw new ContextError("conflict");
      const pin = this.repository.write(`skills/${skillId}/${version}.md`, text(markdown));
      this.db.prepare("INSERT INTO skills VALUES (?,?,?,?,?)").run(skillId, version, pin.sha256, pin.commit, pin.path);
      return { id: skillId, version, ...pin };
    });
  }
  activateSkill(value: ContextScope, lock: SkillLock): void {
    this.write(() => {
      const target = this.requireScope(value);
      if (target.kind === "confidential") throw new ContextError("forbidden");
      const stored = this.skill(id(lock.id), text(lock.version, 64));
      if (stored.sha256 !== lock.sha256 || stored.commit !== lock.commit || stored.path !== lock.path) throw new ContextError("tampered");
      this.repository.read(stored);
      this.db.prepare("INSERT INTO activations VALUES (?,?,?,?) ON CONFLICT(scope_key,skill_id) DO UPDATE SET version=excluded.version,hash=excluded.hash").run(scopeKey(target), stored.id, stored.version, stored.sha256);
    });
  }
  deactivateSkill(value: ContextScope, skillId: string): void {
    this.write(() => { const target = this.requireScope(value); this.db.prepare("DELETE FROM activations WHERE scope_key=? AND skill_id=?").run(scopeKey(target), id(skillId)); });
  }
  private skill(skillId: string, version: string): SkillLock {
    const row = this.one("SELECT * FROM skills WHERE id=? AND version=?", skillId, version);
    if (!row) throw new ContextError("not_found");
    return { id: skillId, version, sha256: row.hash as string, commit: row.git_commit as string, path: row.path as string };
  }
  skills(token: string): Array<SkillLock & { markdown: string }> {
    return this.store.withMemoryExtensionLease(() => {
      const principal = this.principal(token); const selected = new Map<string, SkillLock & { markdown: string }>();
      for (const value of this.ownedScopes(principal).sort((a, b) => {
        const rank = { global: 0, team: 1, bot: 2, confidential: 3 };
        return rank[a.kind] - rank[b.kind] || scopeKey(a).localeCompare(scopeKey(b));
      })) {
        for (const row of this.all("SELECT * FROM activations WHERE scope_key=?", scopeKey(value))) {
          const lock = this.skill(row.skill_id as string, row.version as string);
          if (lock.sha256 !== row.hash) throw new ContextError("tampered");
          selected.set(lock.id, { ...lock, markdown: this.repository.read(lock) });
        }
      }
      return [...selected.values()];
    });
  }
  createArtifact(token: string, markdown: string, origin: string): Artifact {
    return this.write(() => {
      const principal = this.principal(token);
      if (!this.isPrivateMemoryTurn(principal.turnId)) throw new ContextError("forbidden");
      const body = text(markdown); const source = text(origin, 512); const artifactId = `artifact_${randomUUID()}`;
      this.db.prepare("INSERT INTO artifacts VALUES (?,?,0,NULL,NULL)").run(artifactId, principal.botId);
      return this.appendArtifact(artifactId, body, source, null);
    });
  }
  private requireArtifact(token: string, artifactId: string): Row {
    const principal = this.principal(token);
    if (!this.isPrivateMemoryTurn(principal.turnId)) throw new ContextError("forbidden");
    const artifact = this.one("SELECT * FROM artifacts WHERE id=? AND bot_id=?", id(artifactId), principal.botId);
    if (!artifact) throw new ContextError("not_found"); return artifact;
  }
  private revision(artifactId: string, revision: number): ArtifactRevision {
    if (!Number.isInteger(revision) || revision < 1) throw new ContextError("invalid_input");
    const row = this.one("SELECT * FROM revisions WHERE artifact_id=? AND revision=?", artifactId, revision);
    if (!row) throw new ContextError("not_found");
    return { id: artifactId, revision, sha256: row.hash as string, commit: row.git_commit as string, path: row.path as string,
      origin: row.origin as string, createdAt: row.created_at as number, restoredFrom: row.restored_from as number | null };
  }
  private appendArtifact(artifactId: string, markdown: string, origin: string, restoredFrom: number | null): Artifact {
    const artifact = this.one("SELECT * FROM artifacts WHERE id=?", artifactId)!; const revision = (artifact.head as number) + 1;
    const pin = this.repository.write(`artifacts/${artifactId}/r${revision}-${randomUUID()}.md`, markdown);
    this.db.prepare("INSERT INTO revisions VALUES (?,?,?,?,?,?,?,?)").run(artifactId, revision, pin.sha256, pin.commit, pin.path, origin, this.store.now(), restoredFrom);
    this.db.prepare("UPDATE artifacts SET head=? WHERE id=?").run(revision, artifactId);
    return { ...this.revision(artifactId, revision), botId: artifact.bot_id as string, markdown,
      forkedFrom: artifact.fork_id === null ? null : { artifactId: artifact.fork_id as string, revision: artifact.fork_revision as number } };
  }
  artifact(token: string, artifactId: string, revision?: number): Artifact {
    const artifact = this.requireArtifact(token, artifactId); const pin = this.revision(artifactId, revision ?? artifact.head as number);
    return { ...pin, botId: artifact.bot_id as string, markdown: this.repository.read(pin),
      forkedFrom: artifact.fork_id === null ? null : { artifactId: artifact.fork_id as string, revision: artifact.fork_revision as number } };
  }
  reviseArtifact(token: string, artifactId: string, expectedRevision: number, markdown: string, origin: string): Artifact {
    return this.write(() => {
      const artifact = this.requireArtifact(token, artifactId);
      if (artifact.head !== expectedRevision) throw new ContextError("conflict");
      return this.appendArtifact(artifactId, text(markdown), text(origin, 512), null);
    });
  }
  restoreArtifact(token: string, artifactId: string, expectedRevision: number, fromRevision: number): Artifact {
    return this.write(() => {
      const artifact = this.requireArtifact(token, artifactId);
      if (artifact.head !== expectedRevision) throw new ContextError("conflict");
      const source = this.revision(artifactId, fromRevision);
      return this.appendArtifact(artifactId, this.repository.read(source), `restore:${artifactId}:${fromRevision}`, fromRevision);
    });
  }
  artifactHistory(token: string, artifactId: string): ArtifactRevision[] {
    this.requireArtifact(token, artifactId);
    return this.all("SELECT revision FROM revisions WHERE artifact_id=? ORDER BY revision", artifactId).map(row => this.revision(artifactId, row.revision as number));
  }
  forkArtifact(token: string, artifactId: string, revision: number): Artifact {
    return this.write(() => {
      this.requireArtifact(token, artifactId); const source = this.artifact(token, artifactId, revision); const forkId = `artifact_${randomUUID()}`;
      this.db.prepare("INSERT INTO artifacts VALUES (?,?,0,?,?)").run(forkId, source.botId, source.id, source.revision);
      return this.appendArtifact(forkId, source.markdown, `fork:${source.id}:${source.revision}`, null);
    });
  }
}
