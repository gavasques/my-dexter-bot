import { inspect } from "node:util";
import { ConversationRuntime, HostError, type HostStore, type StartedTurn } from "@dexter/hub";
import { Agenda, type AgendaOptions, type AgendaTickReport } from "./index.js";

export interface AgendaHostConsumerOptions {
  store: HostStore;
  runtime: ConversationRuntime;
  agenda?: AgendaOptions;
}
export interface AgendaConsumerStatus {
  running:boolean;
  admission: "open" | "stopped";
  inFlight: 0 | 1;
  closed: boolean;
  lastOutcome: "idle" | "completed" | "failed";
  completedTicks: number;
  accepted: number;
  replayed: number;
  deferred: number;
}
export type AgendaHostAdmin = Readonly<Pick<Agenda,
  "create" | "listSchedules" | "listOccurrences" | "disable" | "enableInterval" |
  "pruneTerminalOccurrences" | "deleteTerminalSchedule" | "get" | "createAutomation" | "updateAutomation" | "stateAutomation" | "runAutomation" | "listAutomations" | "historyAutomations" | "calendarAutomations" | "previewAutomation">>;

/** Manual host-owned acceptance consumer. Agenda is the only occurrence outbox and Hub the turn authority. */
export class AgendaHostConsumer {
  readonly admin: AgendaHostAdmin;
  readonly #store: HostStore;
  readonly #agenda: Agenda;
  readonly #ownerId: string;
  readonly #installationId: string;
  readonly #startTurn: ConversationRuntime["startTurn"];
  readonly #isBoundTo: (store: HostStore) => boolean;
  #timer:ReturnType<typeof setTimeout>|null=null;
  #running=false;
  #cadence=15_000;
  #stopped = false;
  #closed = false;
  /** Monotonic: set by any tick or admin entry; an eligible consumer never becomes eligible again. */
  #used = false;
  #disposal: { failed: unknown } | "done" | null = null;
  #flight: Promise<AgendaTickReport> | null = null;
  #closing: Promise<void> | null = null;
  #last: AgendaConsumerStatus["lastOutcome"] = "idle";
  #ticks = 0;
  #accepted = 0;
  #replayed = 0;
  #deferred = 0;

  constructor(input: AgendaHostConsumerOptions) {
    const options = { ...input };
    if (Object.keys(options).some(key => !["store", "runtime", "agenda"].includes(key)))
      throw new HostError("invalid_input", "Invalid agenda consumer configuration.");
    const store = options.store, runtime = options.runtime;
    if (!(runtime instanceof ConversationRuntime)) throw new HostError("invalid_input", "Agenda requires the canonical conversation runtime.");
    // Pinned to the canonical method: an instance or subclass override cannot forge the binding.
    // startTurn stays the instance's so a trusted host can wrap it for fault injection.
    const canonicalBinding = ConversationRuntime.prototype.isBoundTo;
    const binding = (candidate: HostStore) => canonicalBinding.call(runtime, candidate), start = runtime.startTurn.bind(runtime);
    if (!binding(store)) throw new HostError("conflict", "Agenda runtime does not belong to this host.");
    this.#store = store;
    this.#ownerId = store.ownerId; this.#installationId = store.hostId;
    this.#isBoundTo = binding; this.#startTurn = start;
    const config = options.agenda === undefined ? {} : { ...options.agenda };
    if (Object.keys(config).some(key => !["clock", "maxSchedulesPerTick", "maxDispatchesPerTick"].includes(key)))
      throw new HostError("invalid_input", "Invalid agenda consumer limits.");
    this.admin = Object.freeze({
      get:id=>this.#admin(()=>this.#agenda.get(id)),
      createAutomation:input=>this.#admin(()=>this.#agenda.createAutomation(input)),
      updateAutomation:(id,input)=>this.#admin(()=>this.#agenda.updateAutomation(id,input)),
      stateAutomation:(id,input)=>this.#admin(()=>this.#agenda.stateAutomation(id,input)),
      runAutomation:(id,input)=>this.#admin(()=>this.#agenda.runAutomation(id,input)),
      listAutomations:input=>this.#admin(()=>this.#agenda.listAutomations(input)),
      historyAutomations:input=>this.#admin(()=>this.#agenda.historyAutomations(input)),
      calendarAutomations:input=>this.#admin(()=>this.#agenda.calendarAutomations(input)),
      previewAutomation:input=>this.#admin(()=>this.#agenda.previewAutomation(input)),
      create: input => this.#admin(() => this.#agenda.create(input)),
      listSchedules: options => this.#admin(() => this.#agenda.listSchedules(options)),
      listOccurrences: options => this.#admin(() => this.#agenda.listOccurrences(options)),
      disable: id => this.#admin(() => this.#agenda.disable(id)),
      enableInterval: (id, at) => this.#admin(() => this.#agenda.enableInterval(id, at)),
      pruneTerminalOccurrences: options => this.#admin(() => this.#agenda.pruneTerminalOccurrences(options)),
      deleteTerminalSchedule: id => this.#admin(() => this.#agenda.deleteTerminalSchedule(id)),
    } satisfies AgendaHostAdmin);
    this.#checkBinding();
    // Opening the owned Agenda is the last fallible step, so a failed construction never leaves a handle behind.
    this.#agenda = new Agenda(store, config);
  }
  #checkBinding(): void {
    this.#store.withWriterLease(() => {
      if (this.#store.ownerId !== this.#ownerId || this.#store.hostId !== this.#installationId || !this.#isBoundTo(this.#store))
        throw new HostError("conflict", "Agenda host binding changed.");
    });
  }
  #admit(): void {
    if (this.#stopped) throw new HostError("conflict", "Agenda consumer admission is stopped.");
    this.#checkBinding();
  }
  #admin<T>(work: () => T): T { this.#used = true; this.#admit(); return work(); }

  /** One bounded manual pass; concurrent callers join the same pass rather than adding work. */
  tick(): Promise<AgendaTickReport> {
    this.#used = true;
    if (arguments.length !== 0) return Promise.reject(new HostError("invalid_input", "Agenda tick accepts no request payload."));
    try { this.#admit(); } catch (error) { return Promise.reject(error); }
    if (this.#flight) return this.#flight;
    const flight = Promise.resolve().then(() => {
      // A synchronous stop immediately after tick must not start a turn from the deferred job.
      this.#admit();
      const report = this.#agenda.tick({ startTurn: (threadId, input): StartedTurn => {
        this.#admit();
        // Principal and text came from Agenda's fenced canonical schedule snapshot, never a tick payload.
        const started = this.#startTurn(threadId, input);
        // Confirm the receipt against the same host after acceptance, before Agenda's ACK transaction.
        this.#checkBinding();
        const canonical = this.#store.findTurn(threadId, input.clientRequestId);
        if (!canonical || canonical.id !== started.turn.id || canonical.botId !== this.#store.getThread(threadId).botId)
          throw new HostError("conflict", "Agenda turn receipt is not confirmed.");
        return started;
      } });
      this.#checkBinding();
      this.#ticks++; this.#accepted += report.accepted; this.#replayed += report.replayed; this.#deferred += report.deferred;
      this.#last = "completed";
      return report;
    }).catch(error => { this.#last = "failed"; throw error; })
      .finally(() => { if (this.#flight === flight) this.#flight = null; });
    this.#flight = flight;
    return flight;
  }
  /** Starts only when the trusted host has successfully bound its listeners. No recovery path calls this. */
  start(intervalMs=15_000):void {
    this.#admit();
    if(!Number.isInteger(intervalMs)||intervalMs<10||intervalMs>60_000)throw new HostError("invalid_input","Invalid agenda polling cadence.");
    if(this.#running)return;
    this.#used=true;this.#running=true;this.#cadence=intervalMs;
    this.#schedule(0);
  }
  #schedule(delay:number):void {
    if(!this.#running||this.#stopped)return;
    this.#timer=setTimeout(()=>{
      this.#timer=null;
      void this.tick().catch(()=>{}).finally(()=>this.#schedule(this.#cadence));
    },delay);
    this.#timer.unref?.();
  }
  stopAdmission(): void { this.#stopped = true;this.#running=false;if(this.#timer){clearTimeout(this.#timer);this.#timer=null;} }
  /** Drains the entire accepted tick/ACK and closes only the owned Agenda. Never closes or resumes Runtime/HostStore. */
  close(): Promise<void> {
    this.stopAdmission();
    return this.#closing ??= (async () => {
      if (this.#flight) await Promise.allSettled([this.#flight]);
      this.#agenda.close(); this.#closed = true;
    })();
  }
  /**
   * Trusted synchronous rollback for a host whose later construction step failed. Only a consumer that was never
   * ticked, administered or closed may dispose; refusal changes nothing. It stops admission permanently and closes
   * the owned Agenda between two canonical writer fence checks. Success makes close() an already-resolved no-op.
   * Failure is cached: the consumer stays quarantined, close() rejects with it and nothing is retried or released.
   */
  disposeUnstarted(): void {
    if (this.#disposal === "done") return;
    if (this.#disposal) throw this.#disposal.failed;
    if (this.#used || this.#flight || this.#closing) throw new HostError("conflict", "Agenda consumer was already used; drain it with close().");
    this.#stopped = true;
    try {
      this.#checkBinding();
      this.#agenda.close();
      // Agenda tolerates a lost lease while closing its idle handle; rollback success still requires the same writer.
      this.#checkBinding();
    } catch (error) {
      this.#disposal = { failed: error };
      const failed = Promise.reject(error);
      failed.catch(() => {});
      this.#closing = failed;
      throw error;
    }
    this.#disposal = "done"; this.#closed = true; this.#closing = Promise.resolve();
  }
  status(): AgendaConsumerStatus {
    return { running:this.#running,admission: this.#stopped ? "stopped" : "open", inFlight: this.#flight ? 1 : 0, closed: this.#closed,
      lastOutcome: this.#last, completedTicks: this.#ticks, accepted: this.#accepted, replayed: this.#replayed, deferred: this.#deferred };
  }
  toJSON(): AgendaConsumerStatus { return this.status(); }
  [inspect.custom](): AgendaConsumerStatus { return this.status(); }
}
