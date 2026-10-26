import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BotDelegationSchema, CreateTeamSchema, PatchTeamSchema, TeamSchema, TeamWorkspacesMetadataSchema,
  TEAM_WORKSPACES_META_KEY, MAX_TEAMS, MAX_TEAM_BOTS, MAX_TEAM_BINDINGS, MAX_TEAM_METADATA_BYTES,
  defaultTeamWorkspacesMetadata, teamWorkspacesCanonicalJSON,
  type BotDelegation, type CreateTeam, type PatchTeam, type Team, type TeamThread, type TeamWorkspacesMetadata,
} from "@dexter/contracts";
import type { HostStore, Turn } from "@dexter/hub";
import { sha256 } from "./repository.js";
import { ContextError, id, text } from "./types.js";

type Row = Record<string, unknown>;
type Binding = TeamWorkspacesMetadata["bindings"][string];
type ThreadReceipt = TeamWorkspacesMetadata["threadReceipts"][string];
interface TurnScope { team: Team | null; turns: Turn[]; links: BotDelegation[]; bindingIndex: number; binding: Binding | null }
const requestID = (value: string): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new ContextError("invalid_input");
  return value;
};
const revision = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new ContextError("invalid_input");
  return value;
};

/** Uses Context's canonical teams/members/team_bots registry and its existing fenced transaction. */
export class ContextTeams {
  constructor(private readonly store: HostStore, private readonly db: DatabaseSync,
    private readonly write: <T>(operation: () => T) => T) {}

  private one(sql: string, ...values: Array<string | number>): Row | undefined {
    return this.db.prepare(sql).get(...values) as Row | undefined;
  }
  private all(sql: string, ...values: Array<string | number>): Row[] {
    return this.db.prepare(sql).all(...values) as Row[];
  }
  private metadata(): TeamWorkspacesMetadata {
    this.store.assertActiveWriter();
    const raw = this.one("SELECT value FROM meta WHERE key=?", TEAM_WORKSPACES_META_KEY)?.value;
    if (raw === undefined) return defaultTeamWorkspacesMetadata();
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_TEAM_METADATA_BYTES) throw new ContextError("tampered");
    try {
      const parsed = TeamWorkspacesMetadataSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || teamWorkspacesCanonicalJSON(parsed.data) !== raw) throw new ContextError("tampered");
      return parsed.data;
    } catch { throw new ContextError("tampered"); }
  }
  private save(metadata: TeamWorkspacesMetadata): void {
    const parsed = TeamWorkspacesMetadataSchema.safeParse(metadata);
    if (!parsed.success) throw new ContextError("conflict", "Team metadata capacity or revision exceeded.");
    const raw = teamWorkspacesCanonicalJSON(parsed.data);
    if (Buffer.byteLength(raw, "utf8") > MAX_TEAM_METADATA_BYTES) throw new ContextError("conflict", "Team metadata capacity exceeded.");
    this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(TEAM_WORKSPACES_META_KEY, raw);
  }
  private now(): number {
    const value = this.store.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new ContextError("conflict");
    return value;
  }
  private team(teamId: string, metadata: TeamWorkspacesMetadata): Team {
    const row = this.one("SELECT id,owner_id,name FROM teams WHERE id=?", id(teamId));
    if (!row) throw new ContextError("not_found");
    if (row.owner_id !== this.store.ownerId) throw new ContextError("forbidden");
    const botIds = this.all("SELECT bot_id FROM team_bots WHERE team_id=? ORDER BY bot_id", teamId).map(value => String(value.bot_id));
    const profile = metadata.profiles[teamId];
    const data = TeamSchema.safeParse({id:teamId,ownerId:row.owner_id,name:row.name,botIds,
      avatarEmoji:profile?.avatarEmoji ?? null,roleDescription:profile?.roleDescription ?? "",coordinatorBotId:profile?.coordinatorBotId ?? null,
      avatarImage:profile?.avatarImageId?this.store.getAvatarImage(profile.avatarImageId):null,
      rules:profile?.rules ?? "",memory:profile?.memory ?? "",revision:profile?.revision ?? 0,
      createdAt:profile?.createdAt ?? 0,updatedAt:profile?.updatedAt ?? 0});
    if (!data.success || (profile && !botIds.includes(profile.coordinatorBotId))) throw new ContextError("tampered");
    for (const botId of botIds) this.ownedBot(botId);
    return data.data;
  }
  private ownedBot(botId: string) {
    const bot = this.store.getBot(id(botId));
    if (bot.ownerId !== this.store.ownerId) throw new ContextError("forbidden");
    return bot;
  }
  private activeOwner(teamId: string): void {
    if (this.one("SELECT active FROM members WHERE team_id=? AND owner_id=?", teamId, this.store.ownerId)?.active !== 1)
      throw new ContextError("forbidden", "Team membership is inactive.");
  }
  private validateMembers(botIds: string[], coordinatorBotId: string): void {
    if (botIds.length > MAX_TEAM_BOTS || new Set(botIds).size !== botIds.length || !botIds.includes(coordinatorBotId)) throw new ContextError("invalid_input");
    for (const botId of botIds) this.ownedBot(botId);
  }
  private assertConfigured(team: Team): asserts team is Team & {coordinatorBotId: string} {
    if (!team.coordinatorBotId || team.revision < 1) throw new ContextError("conflict", "Configure the team's coordinator first.");
    this.activeOwner(team.id);
    if (!team.botIds.includes(team.coordinatorBotId)) throw new ContextError("forbidden");
  }
  private nextRevision(value: number): number {
    if (value >= Number.MAX_SAFE_INTEGER - 1) throw new ContextError("conflict", "Team revision exhausted.");
    return value + 1;
  }

  list(): Team[] {
    const metadata = this.metadata();
    const rows = this.all("SELECT id FROM teams WHERE owner_id=? ORDER BY id", this.store.ownerId);
    if (rows.length > MAX_TEAMS) throw new ContextError("tampered");
    return rows.map(row => this.team(String(row.id), metadata));
  }
  get(teamId: string): Team { return this.team(teamId, this.metadata()); }
  create(input: CreateTeam): Team {
    const parsed = CreateTeamSchema.safeParse(input);
    if (!parsed.success) throw new ContextError("invalid_input");
    const data = parsed.data;
    if (data.expectedHostID !== this.store.hostId) throw new ContextError("conflict", "Host identity changed.");
    if(data.avatarImageId)this.store.readAvatarImage(data.avatarImageId);
    const requestHash = sha256(teamWorkspacesCanonicalJSON(data));
    return this.write(() => {
      const metadata = this.metadata(), receipt = metadata.createReceipts[data.clientRequestId];
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw new ContextError("conflict", "Team request id reused.");
        this.team(receipt.team.id, metadata);
        return receipt.team;
      }
      if (this.all("SELECT id FROM teams").length >= MAX_TEAMS || Object.keys(metadata.createReceipts).length >= MAX_TEAMS) throw new ContextError("conflict", "Team limit reached.");
      this.validateMembers(data.botIds, data.coordinatorBotId);
      const teamId = `team_${randomUUID()}`, now = this.now();
      this.db.prepare("INSERT INTO teams VALUES (?,?,?)").run(teamId, this.store.ownerId, data.name);
      this.db.prepare("INSERT INTO members VALUES (?,?,1,1)").run(teamId, this.store.ownerId);
      for (const botId of data.botIds) this.db.prepare("INSERT INTO team_bots VALUES (?,?)").run(teamId, botId);
      metadata.profiles[teamId] = {avatarEmoji:data.avatarEmoji ?? null,avatarImageId:data.avatarImageId ?? null,roleDescription:data.roleDescription ?? "",
        coordinatorBotId:data.coordinatorBotId,rules:data.rules ?? "",memory:data.memory ?? "",revision:1,createdAt:now,updatedAt:now};
      const team = this.team(teamId, metadata);
      metadata.createReceipts[data.clientRequestId] = {requestHash,team};
      this.save(metadata);
      return team;
    });
  }
  update(teamId: string, input: PatchTeam): Team {
    const key = id(teamId), parsed = PatchTeamSchema.safeParse(input);
    if (!parsed.success) throw new ContextError("invalid_input");
    const data = parsed.data;
    if (data.expectedHostID !== this.store.hostId) throw new ContextError("conflict", "Host identity changed.");
    if(data.avatarImageId)this.store.readAvatarImage(data.avatarImageId);
    return this.write(() => {
      const metadata = this.metadata(), current = this.team(key, metadata);
      if (current.revision !== data.expectedRevision) throw new ContextError("conflict", "Team revision changed.");
      this.activeOwner(key);
      const coordinatorBotId = data.coordinatorBotId ?? current.coordinatorBotId;
      if (!coordinatorBotId) throw new ContextError("invalid_input", "A coordinator is required.");
      const botIds = data.botIds ?? current.botIds;
      this.validateMembers(botIds, coordinatorBotId);
      const now = this.now();
      this.db.prepare("UPDATE teams SET name=? WHERE id=?").run(data.name ?? current.name, key);
      if (data.botIds !== undefined) {
        this.db.prepare("DELETE FROM team_bots WHERE team_id=?").run(key);
        for (const botId of botIds) this.db.prepare("INSERT INTO team_bots VALUES (?,?)").run(key, botId);
      }
      metadata.profiles[key] = {avatarEmoji:data.avatarEmoji === undefined ? current.avatarEmoji : data.avatarEmoji,
        avatarImageId:data.avatarImageId===undefined?(current.avatarImage?.id ?? null):data.avatarImageId,
        roleDescription:data.roleDescription ?? current.roleDescription,coordinatorBotId,rules:data.rules ?? current.rules,memory:data.memory ?? current.memory,
        revision:this.nextRevision(current.revision),createdAt:metadata.profiles[key]?.createdAt ?? now,updatedAt:now};
      this.save(metadata);
      return this.team(key, metadata);
    });
  }

  /** Compatibility operations continue to mutate the same canonical rows and bump an operational profile's CAS. */
  createLegacy(name: string): string {
    const checked = text(name, 120);
    return this.write(() => {
      this.metadata();
      if (this.all("SELECT id FROM teams").length >= MAX_TEAMS) throw new ContextError("conflict", "Team limit reached.");
      const teamId = `team_${randomUUID()}`;
      this.db.prepare("INSERT INTO teams VALUES (?,?,?)").run(teamId, this.store.ownerId, checked);
      this.db.prepare("INSERT INTO members VALUES (?,?,1,1)").run(teamId, this.store.ownerId);
      return teamId;
    });
  }
  assignLegacy(teamId: string, botId: string): void {
    this.write(() => {
      const metadata = this.metadata(), current = this.team(teamId, metadata), bot = this.ownedBot(botId);
      this.activeOwner(current.id);
      if (current.botIds.includes(bot.id)) return;
      if (current.botIds.length >= MAX_TEAM_BOTS) throw new ContextError("conflict", "Team member limit reached.");
      this.db.prepare("INSERT INTO team_bots VALUES (?,?)").run(current.id, bot.id);
      const profile = metadata.profiles[current.id];
      if (profile) { profile.revision = this.nextRevision(profile.revision); profile.updatedAt = this.now(); this.save(metadata); }
    });
  }
  setMemberLegacy(teamId: string, ownerId: string, active: boolean): void {
    const memberId = id(ownerId);
    if (typeof active !== "boolean") throw new ContextError("invalid_input");
    this.write(() => {
      const metadata = this.metadata(), current = this.team(teamId, metadata);
      this.db.prepare("INSERT INTO members VALUES (?,?,?,1) ON CONFLICT(team_id,owner_id) DO UPDATE SET active=excluded.active,revision=revision+1")
        .run(current.id, memberId, active ? 1 : 0);
      const profile = metadata.profiles[current.id];
      if (profile) { profile.revision = this.nextRevision(profile.revision); profile.updatedAt = this.now(); this.save(metadata); }
    });
  }

  private bindingThread(threadId: string, binding: Binding): TeamThread {
    const thread = this.store.getThread(id(threadId));
    this.ownedBot(binding.coordinatorBotId);
    if (thread.botId !== binding.coordinatorBotId) throw new ContextError("tampered", "Team thread identity changed.");
    return {teamId:binding.teamId,teamRevision:binding.teamRevision,thread};
  }
  threadTeam(threadId: string): Team | null {
    const metadata = this.metadata(), key = id(threadId), binding = metadata.bindings[key];
    if (!binding) return null;
    this.bindingThread(key, binding);
    return this.team(binding.teamId, metadata);
  }
  listThreads(teamId: string): TeamThread[] {
    const metadata = this.metadata(), team = this.team(teamId, metadata);
    return Object.entries(metadata.bindings).filter(([,binding]) => binding.teamId === team.id && binding.coordinatorBotId === team.coordinatorBotId)
      .map(([threadId,binding]) => this.bindingThread(threadId,binding)).sort((a,b) => b.thread.createdAt-a.thread.createdAt || a.thread.id.localeCompare(b.thread.id));
  }
  private threadHash(teamId: string, expectedRevision: number, clientRequestId: string): string {
    return sha256(teamWorkspacesCanonicalJSON({teamId,expectedRevision,clientRequestId}));
  }
  private receiptThread(metadata: TeamWorkspacesMetadata, receipt: ThreadReceipt): TeamThread {
    const binding = metadata.bindings[receipt.threadId];
    if (!binding || binding.teamId !== receipt.teamId || binding.coordinatorBotId !== receipt.coordinatorBotId
      || binding.teamRevision !== receipt.teamRevision || binding.createdAt !== receipt.createdAt || binding.delegationId !== null) throw new ContextError("tampered");
    this.team(receipt.teamId, metadata);
    return this.bindingThread(receipt.threadId,binding);
  }
  findThreadReceipt(teamId: string, clientRequestId: string, expectedRevision: number): TeamThread | null {
    const key = id(teamId), request = requestID(clientRequestId), expected = revision(expectedRevision), metadata = this.metadata();
    this.team(key,metadata);
    const receipt = metadata.threadReceipts[request];
    if (!receipt) return null;
    if (receipt.teamId !== key || receipt.expectedRevision !== expected || receipt.requestHash !== this.threadHash(key,expected,request))
      throw new ContextError("conflict", "Team thread request id reused.");
    return this.receiptThread(metadata,receipt);
  }
  bindThread(teamId: string, threadId: string, expectedRevision: number, clientRequestId: string): TeamThread {
    const key = id(teamId), threadKey = id(threadId), request = requestID(clientRequestId), expected = revision(expectedRevision);
    return this.write(() => {
      const metadata = this.metadata(), team = this.team(key,metadata), receipt = metadata.threadReceipts[request];
      if (receipt) {
        if (receipt.teamId !== key || receipt.expectedRevision !== expected || receipt.threadId !== threadKey
          || receipt.requestHash !== this.threadHash(key,expected,request)) throw new ContextError("conflict", "Team thread request id reused.");
        return this.receiptThread(metadata,receipt);
      }
      if (team.revision !== expected) throw new ContextError("conflict", "Team revision changed.");
      this.assertConfigured(team);
      const thread = this.store.getThread(threadKey);
      if (thread.botId !== team.coordinatorBotId) throw new ContextError("forbidden", "Team conversation must belong to its coordinator.");
      this.ownedBot(thread.botId);
      if (metadata.bindings[threadKey]) throw new ContextError("conflict", "Thread already belongs to a team.");
      if (this.store.listTurns(threadKey,0,1).length)
        throw new ContextError("forbidden", "A team requires a new conversation; private history is not published by binding.");
      if (Object.keys(metadata.bindings).length >= MAX_TEAM_BINDINGS || Object.keys(metadata.threadReceipts).length >= MAX_TEAM_BINDINGS)
        throw new ContextError("conflict", "Team conversation limit reached.");
      const createdAt = this.now();
      metadata.bindings[threadKey] = {teamId:key,coordinatorBotId:team.coordinatorBotId,teamRevision:team.revision,createdAt,delegationId:null};
      metadata.threadReceipts[request] = {teamId:key,expectedRevision:expected,requestHash:this.threadHash(key,expected,request),
        threadId:threadKey,teamRevision:team.revision,coordinatorBotId:team.coordinatorBotId,createdAt};
      this.save(metadata);
      return {teamId:key,teamRevision:team.revision,thread};
    });
  }

  /** A link is trusted only if the canonical Hub turns, threads and immediate parent/root all agree. */
  private checkLink(link: BotDelegation, targetTurn: Turn): Turn {
    const source = this.store.getTurn(id(link.sourceTurnId)), targetThread = this.store.getThread(id(link.targetThreadId));
    const sourceThread = this.store.getThread(id(link.sourceThreadId));
    this.ownedBot(link.sourceBotId); this.ownedBot(link.targetBotId);
    if ((targetTurn.id !== link.targetTurnId && !this.store.toolContinuationTurns(link.targetTurnId).turnIds.includes(targetTurn.id)) || targetTurn.botId !== link.targetBotId || targetTurn.threadId !== link.targetThreadId
      || source.botId !== link.sourceBotId || source.threadId !== link.sourceThreadId
      || targetThread.botId !== link.targetBotId || sourceThread.botId !== link.sourceBotId) throw new ContextError("tampered", "Delegation provenance is invalid.");
    const parent = this.store.delegationForTurn(source.id), root = this.store.getTurn(id(link.rootId));
    if (link.parentId !== (parent?.id ?? null) || link.rootId !== (parent?.rootId ?? source.id) || link.depth !== (parent?.depth ?? 0)+1
      || link.depth > 3 || root.id !== link.rootId || (parent && link.deadlineAt > parent.deadlineAt)) throw new ContextError("tampered", "Delegation ancestry is invalid.");
    return source;
  }
  private turnScope(turnId: string, metadata: TeamWorkspacesMetadata): TurnScope {
    const turns: Turn[] = [], links: BotDelegation[] = [], seen = new Set<string>();
    let turn = this.store.getTurn(id(turnId)), team: Team | null = null, binding: Binding | null = null, bindingIndex = -1;
    for (;;) {
      if (seen.has(turn.id) || turns.length > 3) throw new ContextError("tampered", "Delegation ancestry is invalid.");
      seen.add(turn.id); turns.push(turn);
      const direct = metadata.bindings[turn.threadId];
      if (direct) {
        this.bindingThread(turn.threadId,direct);
        const current = this.team(direct.teamId,metadata);
        if (team && team.id !== current.id) throw new ContextError("forbidden", "Delegation crosses team scopes.");
        team = current;
        if (binding === null) { binding = direct; bindingIndex = turns.length-1; }
      }
      const link = this.store.delegationForTurn(turn.id);
      if (!link) break;
      links.push(link); turn = this.checkLink(link,turn);
    }
    return {team,turns,links,bindingIndex,binding};
  }
  turnTeam(turnId: string): Team | null { return this.turnScope(turnId,this.metadata()).team; }
  private assertScope(scope: TurnScope, metadata: TeamWorkspacesMetadata): void {
    const {team,binding,bindingIndex,turns,links} = scope;
    if (!team || !binding) return;
    this.assertConfigured(team);
    if (binding.coordinatorBotId !== team.coordinatorBotId) throw new ContextError("forbidden", "Team coordinator changed.");
    for (let index=0; index<=bindingIndex; index++) {
      const turn = turns[index]!;
      if (!team.botIds.includes(turn.botId)) throw new ContextError("forbidden", "Bot no longer belongs to this team.");
      const direct = metadata.bindings[turn.threadId];
      if (direct && direct.coordinatorBotId !== team.coordinatorBotId) throw new ContextError("forbidden", "Team coordinator changed.");
    }
    if (turns[bindingIndex]!.botId !== team.coordinatorBotId) throw new ContextError("forbidden", "Team thread no longer belongs to its coordinator.");
    if (binding.delegationId !== null) {
      const entry = this.store.getDelegation(binding.delegationId), target = this.store.getTurn(entry.targetTurnId);
      this.checkLink(entry,target);
      if (entry.targetThreadId !== turns[bindingIndex]!.threadId || entry.targetBotId !== binding.coordinatorBotId)
        throw new ContextError("tampered", "Team entry delegation changed.");
      const sourceScope = this.turnScope(entry.sourceTurnId,metadata);
      if (sourceScope.team) {
        if (sourceScope.team.id !== team.id) throw new ContextError("forbidden", "Delegation crosses team scopes.");
        this.assertScope(sourceScope,metadata);
        if (!team.botIds.includes(entry.sourceBotId)) throw new ContextError("forbidden", "Bot no longer belongs to this team.");
      } else if (!this.ownedBot(entry.sourceBotId).isMaster) throw new ContextError("forbidden", "Master authority was removed.");
      // Only the original entry turn crosses the unscoped Master boundary; descendants retain canonical ancestry.
      const crossing = links[bindingIndex];
      if (crossing && crossing.id !== entry.id) throw new ContextError("tampered", "Team entry ancestry changed.");
    } else if (links[bindingIndex]) {
      const source = turns[bindingIndex+1]!;
      if (!team.botIds.includes(source.botId)) throw new ContextError("forbidden", "Delegation crosses team scopes.");
    }
  }
  assertTurn(turnId: string): void {
    const metadata = this.metadata(); this.assertScope(this.turnScope(turnId,metadata),metadata);
  }
  filterPeers<T extends {id: string}>(turnId: string, peers: T[]): T[] {
    const metadata = this.metadata(), scope = this.turnScope(turnId,metadata);
    this.assertScope(scope,metadata);
    if (!scope.team) return peers;
    const members = new Set(scope.team.botIds); return peers.filter(peer => members.has(peer.id));
  }
  assertDelegation(sourceTurnId: string, targetBotId: string): void {
    const metadata = this.metadata(), scope = this.turnScope(sourceTurnId,metadata);
    this.assertScope(scope,metadata);
    if (scope.team && !scope.team.botIds.includes(id(targetBotId))) throw new ContextError("forbidden", "Delegation target is outside this team.");
  }
  bindDelegation(teamId: string, value: BotDelegation): TeamThread {
    const key = id(teamId), parsed = BotDelegationSchema.safeParse(value);
    if (!parsed.success) throw new ContextError("invalid_input");
    const incoming = parsed.data;
    return this.write(() => {
      const metadata = this.metadata(), team = this.team(key,metadata), canonical = this.store.getDelegation(incoming.id);
      const immutable = (link: BotDelegation) => ({id:link.id,sourceBotId:link.sourceBotId,targetBotId:link.targetBotId,
        sourceThreadId:link.sourceThreadId,targetThreadId:link.targetThreadId,sourceTurnId:link.sourceTurnId,targetTurnId:link.targetTurnId,
        parentId:link.parentId,rootId:link.rootId,depth:link.depth,deadlineAt:link.deadlineAt,createdAt:link.createdAt,requestHash:link.requestHash,callId:link.callId});
      if (teamWorkspacesCanonicalJSON(immutable(incoming)) !== teamWorkspacesCanonicalJSON(immutable(canonical))) throw new ContextError("conflict", "Delegation identity changed.");
      this.checkLink(canonical,this.store.getTurn(canonical.targetTurnId));
      const existing = metadata.bindings[canonical.targetThreadId];
      if (existing) {
        if (existing.teamId !== key || existing.delegationId !== canonical.id || existing.coordinatorBotId !== canonical.targetBotId)
          throw new ContextError("conflict", "Thread already belongs to a team.");
        this.assertScope(this.turnScope(canonical.targetTurnId,metadata),metadata);
        return this.bindingThread(canonical.targetThreadId,existing);
      }
      this.assertConfigured(team);
      if (canonical.targetBotId !== team.coordinatorBotId) throw new ContextError("forbidden", "Team order must target its coordinator.");
      const sourceScope = this.turnScope(canonical.sourceTurnId,metadata);
      this.assertScope(sourceScope,metadata);
      if (sourceScope.team ? sourceScope.team.id !== key : !this.ownedBot(canonical.sourceBotId).isMaster)
        throw new ContextError("forbidden", "Team order requires its own member or the Master.");
      if (sourceScope.team && !team.botIds.includes(canonical.sourceBotId)) throw new ContextError("forbidden");
      const source = this.store.getTurn(canonical.sourceTurnId), root = this.store.getTurn(canonical.rootId);
      if (source.state !== "running" || root.state !== "running" || !["pending","running"].includes(canonical.state)
        || canonical.deadlineAt <= this.now()) throw new ContextError("forbidden", "Team order is no longer dispatchable.");
      if (Object.keys(metadata.bindings).length >= MAX_TEAM_BINDINGS) throw new ContextError("conflict", "Team conversation limit reached.");
      const binding: Binding = {teamId:key,coordinatorBotId:team.coordinatorBotId,teamRevision:team.revision,
        createdAt:this.now(),delegationId:canonical.id};
      metadata.bindings[canonical.targetThreadId] = binding;
      this.save(metadata);
      return this.bindingThread(canonical.targetThreadId,binding);
    });
  }
}
