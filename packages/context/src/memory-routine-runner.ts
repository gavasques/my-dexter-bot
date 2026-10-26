import { MemoryRoutineExtractorResultSchema, type MemoryRoutineJob } from '@dexter/contracts';
import { MemoryRoutineStore } from './memory-routine-store.js';
export interface MemoryRoutineExtractor {
    readonly kind?: 'literal_excerpt';
    extract(input: Readonly<{
        source: NonNullable<MemoryRoutineJob['source']>;
        excerpt: string;
        truncated: boolean;
        maxNoteCharacters: number;
    }>, signal: AbortSignal): Promise<unknown>;
}
/** No model, CLI, network or tool router is supplied by this runner. Extraction returns untrusted candidates only. */
export class MemoryRoutineRunner {
    private readonly flights = new Map<string, {
        botId: string;
        controller: AbortController;
        done: Promise<void>;
    }>();
    private stopped = false;
    constructor(private readonly store: MemoryRoutineStore, private readonly extractor?: MemoryRoutineExtractor) {
    }
    get configured() {
        return this.extractor !== undefined;
    }
    get extractorKind() {
        return this.extractor === undefined ? 'unconfigured' as const : this.extractor.kind ?? 'injected' as const;
    }
    observe(turnId: string): Promise<void> {
        if (this.stopped || !this.extractor || this.flights.size >= 2)
            return Promise.resolve();
        const admission = this.store.beginCapture(turnId);
        if (!admission)
            return Promise.resolve();
        const { job, excerpt } = admission, controller = new AbortController();
        const done = this.run(job, excerpt, controller).finally(() => this.flights.delete(job.id));
        this.flights.set(job.id, { botId: job.botId, controller, done });
        return done;
    }
    private async run(job: MemoryRoutineJob, excerpt: string, controller: AbortController) {
        let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {
        };
        try {
            const stopped = new Promise<never>((_, reject) => {
                abort = () => reject(new Error('Routine stopped'));
                controller.signal.addEventListener('abort', abort, { once: true });
            });
            timer = setTimeout(() => controller.abort(), 10000);
            const value = await Promise.race([this.extractor!.extract(Object.freeze({ source: Object.freeze({ ...job.source! }), excerpt, truncated: job.source!.outputCharacters > excerpt.length, maxNoteCharacters: this.store.policy(job.botId).maxNoteCharacters }), controller.signal), stopped]);
            const parsed = MemoryRoutineExtractorResultSchema.safeParse(value);
            if (!parsed.success)
                this.store.settleCapture(job.id, null, 'invalid');
            else
                this.store.settleCapture(job.id, parsed.data?.note ?? null, parsed.data === null ? 'empty' : 'candidate');
        }
        catch {
            this.store.settleCapture(job.id, null, controller.signal.aborted ? 'withdrawn' : 'unknown');
        }
        finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abort);
        }
    }
    invalidate(botId: string) {
        for (const flight of this.flights.values())
            if (flight.botId === botId)
                flight.controller.abort();
    }
    stopAdmission() {
        this.stopped = true;
        for (const flight of this.flights.values())
            flight.controller.abort();
    }
    async close() {
        this.stopAdmission();
        await Promise.allSettled([...this.flights.values()].map(flight => flight.done));
    }
}
