import type { BotDelegation, CreateTeam, PatchTeam, Team, TeamThread } from "@dexter/contracts";

/** Trusted local owner administration and read-only dispatch policy. Membership never grants bot capabilities. */
export interface HostTeamsPort {
  list(): Team[];
  get(teamId: string): Team;
  create(input: CreateTeam): Team;
  update(teamId: string, input: PatchTeam): Team;
  listThreads(teamId: string): TeamThread[];
  findThreadReceipt(teamId: string, clientRequestId: string, expectedRevision: number): TeamThread | null;
  bindThread(teamId: string, threadId: string, expectedRevision: number, clientRequestId: string): TeamThread;
  threadTeam(threadId: string): Team | null;
  turnTeam(turnId: string): Team | null;
  assertTurn(turnId: string): void;
  filterPeers<T extends { id: string }>(turnId: string, peers: T[]): T[];
  assertDelegation(sourceTurnId: string, targetBotId: string): void;
  bindDelegation(teamId: string, delegation: BotDelegation): TeamThread;
}
