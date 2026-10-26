import type { BotDelegation } from '@dexter/contracts';
import { HostError } from './errors.js';
import type { HostStore } from './store.js';
import type { ConversationRuntime } from './runtime.js';
import type { HostTeamsPort } from './teams-port.js';
import { assertDelegationSource, readDelegationResults } from './delegation-results.js';

/** Explicit trusted composition, using only the canonical writer/runtime. Never issues tool grants. */
export class BotDelegationRuntime {
  private stopped = false;
  private readonly calls = new Map<string, Promise<BotDelegation>>();
  constructor(private readonly store: HostStore, private readonly runtime: ConversationRuntime, private readonly teams?: Readonly<HostTeamsPort>) {
    if (!runtime.isBoundTo(store)) throw new HostError('forbidden', 'Delegation runtime identity mismatch.');
  }
  peers(turnId: string) { return this.store.withWriterLease(() => this.store.delegationPeers(turnId)); }
  async delegate(turnId: string, callId: string, input: unknown, signal?: AbortSignal, trustedTeamId?:string): Promise<BotDelegation> {
    if (this.stopped || signal?.aborted) throw new HostError('forbidden', 'Delegation stopped.');
    this.store.withWriterLease(()=>assertDelegationSource(this.store,turnId,this.teams));
    const parent = this.store.delegationForTurn(turnId);
    const deadline = Math.min(parent?.deadlineAt ?? this.runtime.turnDeadline(turnId),this.store.now()+285_000);
    const admitted = this.store.createDelegation(turnId, callId, input, deadline, trustedTeamId);
    const row = admitted.delegation;
    if(trustedTeamId!==undefined){
      try {if(!this.teams)throw new HostError('forbidden','Team routing unavailable.');this.teams.bindDelegation(trustedTeamId,row);}
      catch(error){if(admitted.created){this.runtime.cancelTurn(row.targetTurnId);this.store.updateDelegation(row.id,'failed');}throw error;}
    }
    // Revalidate even persisted replays; never expose a former child after permissions changed.
    this.results(turnId,{delegationId:row.id});
    const active = this.calls.get(row.id); if (active) return active;
    // Persistence replays never start work; only a newly committed admission may schedule its child.
    if (!admitted.created) return row;
    const operation = this.execute(row, signal);
    this.calls.set(row.id, operation);
    try { return await operation; } finally { this.calls.delete(row.id); }
  }
  private async execute(row: BotDelegation, signal?: AbortSignal): Promise<BotDelegation> {
    const observed = new Set([row.targetTurnId]);
    const abort = () => { for (const turnId of [...observed].reverse()) this.runtime.cancelTurn(turnId); };
    signal?.addEventListener('abort', abort, {once:true});
    const timeout = setTimeout(abort, Math.max(1, row.deadlineAt - this.store.now()));
    try {
      if (this.stopped || signal?.aborted) abort();
      else {
        this.store.assertDelegationDispatch(row.targetTurnId);
        this.store.updateDelegation(row.id, 'running');
        this.runtime.scheduleDelegatedTurn(row.targetTurnId);
      }
      for (;;) {
        const chain = this.store.toolContinuationTurns(row.targetTurnId);
        for (const id of chain.turnIds) observed.add(id);
        const finalId = chain.turnIds.at(-1)!, terminal = this.store.getTurn(finalId);
        if (this.stopped || signal?.aborted || this.store.now() >= row.deadlineAt) throw new HostError('forbidden','Delegation wait stopped.');
        this.store.assertDelegationDispatch(finalId);
        if (!['queued','running'].includes(terminal.state) && !chain.awaitingReceipt) {
          const state = chain.effectsUnknown || terminal.state === 'unknown' ? 'unknown' : terminal.state === 'completed' ? 'completed'
            : terminal.state === 'interrupted' ? 'cancelled' : 'failed';
          return this.store.updateDelegation(row.id,state,state === 'completed' ? this.store.turnOutput(finalId) : null);
        }
        // Live authority is checked again after every await. Events wake this wait;50ms is the bounded
        // fallback for policy revocation/sibling completion, not a new job or a tool replay.
        await new Promise<void>(resolve => {
          let timer:ReturnType<typeof setTimeout>;
          const done = () => { clearTimeout(timer); unturn(); unaction(); signal?.removeEventListener('abort',done); resolve(); };
          const unturn = this.runtime.subscribe(notice => { if (notice.threadId === row.targetThreadId) done(); });
          const unaction = this.store.subscribeActions(id => { if (this.store.getAction(id).request.threadId === row.targetThreadId) done(); });
          signal?.addEventListener('abort',done,{once:true}); timer = setTimeout(done,Math.max(1,Math.min(50,row.deadlineAt-this.store.now())));
        });
      }
    } catch {
      abort();
      // A failed wait is not proof the child stopped. Record uncertainty without replaying.
      const current = this.store.getTurn([...observed].at(-1)!);
      return this.store.updateDelegation(row.id,current.state === 'interrupted' ? 'cancelled' : current.state === 'failed' ? 'failed' : 'unknown');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); }
  }
  results(turnId:string,input:unknown={}) { return readDelegationResults(this.store,turnId,input,this.teams); }
  list(botId?: string) { return this.store.listDelegations(botId); }
  get(id: string) { return this.store.getDelegation(id); }
  cancel(id: string): BotDelegation {
    const row = this.get(id); this.runtime.cancelTurn(row.targetTurnId);
    const chain = this.store.toolContinuationTurns(row.targetTurnId), child = this.store.getTurn(chain.turnIds.at(-1)!);
    if (child.state === 'interrupted') return this.store.updateDelegation(id,'cancelled');
    if (child.state === 'unknown') return this.store.updateDelegation(id,'unknown');
    return this.get(id);
  }
  stopAdmission(): void { this.stopped = true; }
  async close(): Promise<void> { this.stopAdmission(); await Promise.allSettled([...this.calls.values()]); }
}
