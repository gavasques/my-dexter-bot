// Child process of the G8 authority tests: a separate OS process that runs one role and reports through the IPC
// channel. Synthetic custody arrives over IPC only (never a file). Crash points SIGKILL this process at an exact
// controller step, so the parent observes real persisted state after an abrupt death.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { HostStore } from "@dexter/hub";
import { AuthorityCoordinator, runCli, type OperationPin } from "@dexter/operations";
import { HostServices } from "../packages/cli/src/host-services.js";
import { custodyFromWire } from "./authority-fixture.js";

type Message = { custody?: { ownerPkcs8: string; secret: string; keyId: string }; command?: "release" | "die" };
const role = process.argv[2]!;
const args = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;
const send = (value: unknown): Promise<void> => new Promise((done) => { process.send!(value, () => done()); });
const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  throw new Error("not killed");
};
const code = (error: unknown): string => {
  const value = error as { code?: unknown; name?: unknown };
  return typeof value?.code === "string" ? `${String(value.name)}:${value.code}` : "internal";
};
function nextMessage(): Promise<Message> { return new Promise((done) => process.once("message", (message) => done(message as Message))); }

function installCrash(point: string | undefined): void {
  if (!point) return;
  const after = (proto: object, name: string): void => {
    const target = proto as Record<string, (...a: unknown[]) => unknown>;
    const original = target[name]!;
    target[name] = function patched(this: unknown, ...a: unknown[]) { original.apply(this, a); return die(); };
  };
  const before = (proto: object, name: string): void => {
    const target = proto as Record<string, (...a: unknown[]) => unknown>;
    target[name] = function patched() { return die(); };
  };
  switch (point) {
    case "after-checkpoint": return after(HostStore.prototype, "checkpointForTransfer");
    case "after-revoke": return after(HostStore.prototype, "revokeForTransfer");
    case "after-consume": return after(AuthorityCoordinator.prototype, "consumeReceipt");
    case "after-destination": return after(AuthorityCoordinator.prototype, "recordDestination");
    case "before-activated-record": return before(AuthorityCoordinator.prototype, "recordActivated");
    case "after-staging-created": return after(AuthorityCoordinator.prototype, "recordStagingCreated");
    case "after-capture-fence": return after(HostStore.prototype, "withCheckpointFence");
    // Filesystem-level points inside the destination reservation window (live ESM bindings of node:fs are patched).
    case "before-destination-mkdir":
    case "after-destination-mkdir": {
      const target = String(args.destination);
      const original = fs.mkdirSync;
      (fs as { mkdirSync: unknown }).mkdirSync = function patched(path: fs.PathLike, options?: fs.MakeDirectoryOptions) {
        if (String(path) === target) {
          if (point === "before-destination-mkdir") return die();
          original(path, options); return die();
        }
        return original(path, options as never);
      };
      syncBuiltinESMExports();
      return;
    }
    default: throw new Error("unknown crash point");
  }
}

async function main(): Promise<void> {
  if (role === "cli") {
    const first = await nextMessage();
    const custody = first.custody ? custodyFromWire(first.custody).provider : undefined;
    installCrash(args.crash as string | undefined);
    const lines: string[] = [];
    const exit = await runCli(args.argv as string[], {
      write: (line) => lines.push(line), ...(custody ? { custody } : {}), ...(typeof args.now === "number" ? { clock: () => args.now as number } : {}),
      ...(Array.isArray(args.catalog) ? { operationCatalog: args.catalog as OperationPin[] } : {}),
    });
    await send({ exit, output: lines.map((line) => JSON.parse(line)) });
    return;
  }
  if (role === "open") {
    try {
      const store = new HostStore({ dataDir: args.dataDir as string });
      const status = store.authorityStatus();
      store.close();
      await send({ ok: true, status: { epoch: status.epoch, state: status.state, provenance: status.provenance } });
    } catch (error) { await send({ ok: false, code: code(error) }); }
    return;
  }
  if (role === "hold") {
    let store: HostStore;
    try { store = new HostStore({ dataDir: args.dataDir as string }); }
    catch (error) { await send({ ok: false, code: code(error) }); return; }
    await send({ ok: true, pid: process.pid, epoch: store.authorityStatus().epoch });
    const message = await nextMessage();
    if (message.command === "die") die();
    store.close();
    await send({ released: true });
    return;
  }
  if (role === "services") {
    // The REAL HostServices (engines, agenda, app clients) restarted on a directory, with a counting synthetic driver
    // (no engine, no inference). It must hold what it finds queued and never re-run unknown work: zero driver calls.
    const opens: string[] = []; const turns: string[] = [];
    let services: HostServices;
    try {
      services = new HostServices({
        dataDir: args.dataDir as string, enableEngines: true, enableAgenda: true,
        makeDriver(engine) {
          return {
            id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
            async status() { return { engine, installed: true, version: "synthetic", authentication: "authenticated", billing: "subscription" }; },
            async open(threadId: string, cursor?: string) { opens.push(threadId); return { threadId, nativeCursor: cursor ?? "synthetic" }; },
            async *turn(session: { threadId: string }, turnId: string) { turns.push(turnId); yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
            async close() {}, async interrupt() {}, async respondToTool() {},
          } as never;
        },
      });
    } catch (error) { await send({ ok: false, code: code(error) }); return; }
    await new Promise((done) => setTimeout(done, 300));
    const store = services.store;
    const report: Record<string, unknown> = {
      ok: true, epoch: store.authorityStatus().epoch, provenance: store.authorityStatus().provenance, opensBefore: opens.length, turnsBefore: turns.length,
      queued: store.listTurnsByState("queued").map((turn) => turn.clientRequestId).sort(),
      unknownTurns: store.listTurnsByState("unknown").map((turn) => turn.clientRequestId).sort(),
    };
    try { services.runtime!.startTurn(args.heldThreadId as string, { clientRequestId: "after-restart", content: "synthetic" }); report.heldThread = "accepted"; }
    catch (error) { report.heldThread = code(error); }
    // A new thread proves the restarted runtime is functional: exactly one new driver turn.
    const thread = store.createThread(args.botId as string);
    services.runtime!.startTurn(thread.id, { clientRequestId: "fresh-1", content: "synthetic fresh" });
    for (let i = 0; i < 200 && store.listTurnsByState("completed").every((turn) => turn.clientRequestId !== "fresh-1"); i++) await new Promise((done) => setTimeout(done, 10));
    report.turnsAfter = turns.length;
    report.freshState = store.listTurnsByState("completed").some((turn) => turn.clientRequestId === "fresh-1") ? "completed" : "not_completed";
    await services.shutdown({ graceMs: 2_000 });
    await send(report);
    return;
  }
  if (role === "old-seed" || role === "old-open") {
    // Real old code: the unmodified current Root Hub (schema 3) built separately from the candidate.
    const old = await import(args.hubDist as string) as { HostStore: new (o: { dataDir: string }) => {
      createBot(i: object): { id: string }; createThread(b: string): { id: string }; appendMessage(t: string, m: object): unknown;
      summary(): { schemaVersion: number }; close(): void;
    } };
    try {
      const store = new old.HostStore({ dataDir: args.dataDir as string });
      let report: Record<string, unknown> = { ok: true, schemaVersion: store.summary().schemaVersion };
      if (role === "old-seed") {
        const bot = store.createBot({ name: "Legacy", profileId: "personal", engine: "claude" });
        const thread = store.createThread(bot.id);
        store.appendMessage(thread.id, { clientMessageId: "legacy-1", content: "synthetic legacy message" });
        report = { ...report, botId: bot.id, threadId: thread.id };
      }
      store.close();
      await send(report);
    } catch (error) { await send({ ok: false, code: code(error) }); }
    return;
  }
  throw new Error("unknown role");
}

main().then(() => process.exit(0), () => process.exit(3));
