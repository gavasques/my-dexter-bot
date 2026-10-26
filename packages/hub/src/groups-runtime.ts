import type { GroupDispatch, GroupReceipt, GroupRecipient } from '@dexter/contracts';
import { HostError } from './errors.js';
import type { HostStore } from './store.js';
import type { ConversationRuntime } from './runtime.js';
const terminal = new Set(['completed', 'cancelled', 'revoked', 'failed', 'unknown']);
/** One explicit human round, globally serial in this composition; uses the real normal Hub runtime. */
export class GroupConversationRuntime {
    private stopped = false;
    private readonly pending = new Set<string>();
    private readonly jobs = new Map<string, Promise<void>>();
    private tail: Promise<void> = Promise.resolve();
    constructor(private readonly store: HostStore, private readonly runtime: ConversationRuntime, private readonly deadlineMs = 285000) { if (!runtime.isBoundTo(store) || deadlineMs < 1 || deadlineMs > 285000)
        throw new HostError('forbidden', 'Groups runtime composition mismatch.'); store.groups.claimRuntime(this); try {
        store.groups.recover();
    }
    catch (error) {
        store.groups.releaseRuntime(this);
        throw error;
    } }
    send(conversationId: string, input: unknown): GroupDispatch { if (this.stopped)
        throw new HostError('host_locked', 'Groups admission stopped.'); const r = this.store.groups.send(conversationId, input, this.deadlineMs); if (r.created)
        this.enqueue(r.dispatch.id); return r.dispatch; }
    private enqueue(id: string): void { if (this.stopped || this.pending.has(id))
        return; this.pending.add(id); const job = this.tail.then(() => this.execute(id)).catch(() => { }).finally(() => { this.pending.delete(id); this.jobs.delete(id); }); this.jobs.set(id, job); this.tail = job; }
    async wait(id: string): Promise<GroupDispatch> { await this.jobs.get(id); return this.store.groups.getDispatch(id); }
    get(id: string): GroupDispatch { return this.store.groups.getDispatch(id); }
    stop(id: string, input: unknown): GroupReceipt { const receipt = this.store.groups.stop(id, input); const d = this.get(id); for (const r of d.recipients)
        if (!terminal.has(r.state))
            this.cancelRecorded(r); this.store.groups.finish(id); return receipt; }
    resume(id: string, input: unknown): GroupReceipt { if (this.stopped)
        throw new HostError('host_locked', 'Groups admission stopped.'); const receipt = this.store.groups.resume(id, input); if (this.get(id).state === 'queued')
        this.enqueue(id); return receipt; }
    private recorded(r: GroupRecipient): string[] { const ids = new Set(r.observedTurnIds); if (r.turnId) {
        ids.add(r.turnId);
        try {
            for (const id of this.store.toolContinuationTurns(r.turnId).turnIds)
                ids.add(id);
        }
        catch { /* Only proven recorded correlations grant cancellation. */ }
    } return [...ids]; }
    private cancelRecorded(r: GroupRecipient): void { for (const id of this.recorded(r).reverse()) {
        try {
            this.runtime.cancelTurn(id);
        }
        catch { /* Store/runtime may be fenced; never target another bot/thread. */ }
    } }
    private async cancelled(r: GroupRecipient, reason: string, revoked = false): Promise<void> {
        this.cancelRecorded(r);
        if (!r.turnId) {
            this.store.groups.complete(r.id, revoked ? 'revoked' : 'cancelled', reason);
            return;
        }
        const cutoff = Date.now() + 1000;
        let last = this.runtime.getTurn(r.turnId);
        for (;;) {
            const ids = this.recorded(r);
            last = this.runtime.getTurn(ids.at(-1) ?? r.turnId);
            if (!['queued', 'running'].includes(last.state) || Date.now() >= cutoff)
                break;
            await this.pause(r.threadId!, Math.min(50, cutoff - Date.now()));
            this.store.assertActiveWriter();
        }
        const unknown = last.state === 'unknown' || ['queued', 'running'].includes(last.state) || this.store.toolContinuationTurns(r.turnId).effectsUnknown;
        this.store.groups.complete(r.id, unknown ? 'unknown' : revoked ? 'revoked' : 'cancelled', reason + (unknown ? '_effects_unknown' : ''));
    }
    private async execute(id: string): Promise<void> {
        for (const original of this.get(id).recipients) {
            let r = this.store.groups.recipientById(original.id);
            if (terminal.has(r.state))
                continue;
            const d = this.get(id);
            if (this.stopped || d.stopRequested || this.store.now() >= d.deadlineAt) {
                await this.cancelled(r, this.stopped ? 'host_stopped' : d.stopRequested ? 'owner_stop' : 'deadline');
                continue;
            }
            try {
                const prepared = this.store.groups.prepareRecipient(r.id);
                const thread = this.store.createGroupThread(r.id,r.botId,prepared.threadId);
                // Persistence before inference: normal queued turn is not kicked until its exact participant link commits.
                const started = this.store.createTurn(thread.id, { clientRequestId: r.id, content: prepared.content });
                this.store.groups.bindTurn(r.id, started.turn.id);
                r = this.store.groups.recipientById(r.id);
                this.runtime.scheduleGroupTurn(started.turn.id);
                for (;;) {
                    this.store.assertActiveWriter();
                    const current = this.get(id);
                    if (this.stopped || current.stopRequested || this.store.now() >= current.deadlineAt) {
                        await this.cancelled(r, this.stopped ? 'host_stopped' : current.stopRequested ? 'owner_stop' : 'deadline');
                        break;
                    }
                    const chain = this.store.toolContinuationTurns(started.turn.id);
                    this.store.groups.observe(r.id, chain.turnIds, chain.approvalPending ? 'awaiting_approval' : 'running');
                    r = this.store.groups.recipientById(r.id);
                    const last = chain.turnIds.at(-1)!;
                    try {
                        this.store.groups.assertTurn(last);
                    }
                    catch {
                        await this.cancelled(r, 'membership_revoked', true);
                        break;
                    }
                    const turn = this.runtime.getTurn(last);
                    if (!['queued', 'running'].includes(turn.state) && !chain.awaitingReceipt) {
                        const children = this.store.groups.childSummary(r.id);
                        if (children.pending)
                            this.cancelRecorded(r);
                        const state = children.pending || children.unknown || chain.effectsUnknown || turn.state === 'unknown' ? 'unknown' : turn.state === 'completed' ? 'completed' : turn.state === 'interrupted' ? 'cancelled' : 'failed';
                        this.store.groups.complete(r.id, state, turn.code, last);
                        break;
                    }
                    await this.pause(thread.id, Math.max(1, Math.min(50, current.deadlineAt - this.store.now())));
                }
            }
            catch (error) {
                this.store.assertActiveWriter();
                r = this.store.groups.recipientById(original.id);
                if (!terminal.has(r.state)) {
                    if (r.turnId)
                        await this.cancelled(r, 'admission_or_authority_changed', true);
                    else
                        this.store.groups.complete(r.id, error instanceof HostError && error.code === 'forbidden' ? 'revoked' : 'failed', 'admission_refused_before_engine');
                }
            }
        }
        this.store.groups.finish(id);
    }
    private pause(threadId: string, ms: number): Promise<void> { return new Promise(resolve => { let timer: ReturnType<typeof setTimeout>; const done = () => { clearTimeout(timer); unturn(); unaction(); resolve(); }; const unturn = this.runtime.subscribe(n => { if (n.threadId === threadId)
        done(); }); const unaction = this.store.subscribeActions(id => { if (this.store.getAction(id).request.threadId === threadId)
        done(); }); timer = setTimeout(done, ms); }); }
    stopAdmission(): void { this.stopped = true; for (const id of this.pending) {
        try {
            for (const r of this.get(id).recipients)
                if (!terminal.has(r.state))
                    this.cancelRecorded(r);
        }
        catch { /* Recovery retains uncertainty when fenced. */ }
    } }
    async close(): Promise<void> { this.stopAdmission(); await Promise.allSettled([...this.jobs.values()]); this.store.groups.releaseRuntime(this); }
}
