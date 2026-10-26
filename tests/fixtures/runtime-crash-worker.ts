/**
 * External process for runtime durability: `runtime-crash-worker <dataDir> <threadId> <effectFile>`.
 * Accepts one turn whose driver records an inference effect, streams one delta, then SIGKILLs the
 * process while the turn is running.
 */
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { ConversationRuntime, HostStore, type RuntimeDriver, type RuntimeEngineEvent, type RuntimeSession } from "@dexter/hub";

const [dataDir, threadId, effectFile] = process.argv.slice(2);
if (!dataDir || !threadId || !effectFile) throw new Error("usage: runtime-crash-worker <dataDir> <threadId> <effectFile>");

const driver: RuntimeDriver = {
  id: "claude",
  async open(id: string, cursor?: string): Promise<RuntimeSession> { return { threadId: id, nativeCursor: cursor ?? "crash-cursor" }; },
  async *turn(session: RuntimeSession, turnId: string): AsyncIterable<RuntimeEngineEvent> {
    appendFileSync(effectFile, "inference\n");
    const fd = openSync(effectFile, "r"); fsyncSync(fd); closeSync(fd);
    yield { type: "text.delta", threadId: session.threadId, turnId, text: "partial answer" };
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 20);
    await new Promise<void>(() => {});
  },
  async respondToTool(): Promise<void> {},
  async interrupt(): Promise<void> {},
  async close(): Promise<void> {},
};

const store = new HostStore({ dataDir });
const runtime = new ConversationRuntime({ store, drivers: [driver] });
runtime.startTurn(threadId, { clientRequestId: "crash-1", content: "say something" });
process.stdout.write("accepted\n");
setInterval(() => {}, 1_000);
