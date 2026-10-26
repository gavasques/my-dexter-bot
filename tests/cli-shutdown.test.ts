import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ConversationRuntime, HostError, HostStore } from "@dexter/hub";
import { FakeEngine, delay } from "./fixtures/runtime-fake-engine.js";

// Exercise the actual CLI drain loop against a live runtime, without a listener, signals or inference.
const { shutdownRuntime } = await import(pathToFileURL(resolve("packages/cli/dist/index.js")).href) as {
  shutdownRuntime: (runtime: ConversationRuntime, report: (message: string) => void,
    options: { graceMs: number; retryMs: number }) => Promise<void>;
};

test("CLI retries an incomplete shutdown, retains its writer and reports eventual completion", { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cli-drain-"));
  const store = new HostStore({ dataDir: dir });
  const engine = new FakeEngine();
  let release = (): void => {};
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  engine.close = async () => { await gate; };
  const runtime = new ConversationRuntime({ store, drivers: [engine], abortGraceMs: 10 });
  t.after(async () => { release(); await runtime.shutdown({ graceMs: 500 }); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "Review", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  const turn = runtime.startTurn(thread.id, { clientRequestId: "drain", content: "echo:done" }).turn;
  await runtime.waitForTurn(turn.id);
  const messages: string[] = [];
  let calls = 0;
  const original = runtime.shutdown.bind(runtime);
  runtime.shutdown = (options) => { calls += 1; return original(options); };
  let finished = false;
  const draining = shutdownRuntime(runtime, (message) => messages.push(message), { graceMs: 10, retryMs: 20 })
    .then(() => { finished = true; });
  await delay(120);
  assert.equal(finished, false);
  assert.equal(runtime.status().state, "draining");
  assert.equal(messages.length, 1, "incomplete status is reported once, without repetitive logs");
  assert.match(messages[0]!, /shutdown incomplete.*writer lease retained/);
  assert.ok(calls >= 2 && calls <= 6, "retry is paced, not a busy loop");
  assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");

  release();
  await draining;
  assert.equal(runtime.status().state, "closed");
  assert.deepEqual(messages, [
    "Host shutdown incomplete; cleanup is not confirmed. Store and writer lease retained.",
    "Host shutdown complete; writer released.",
  ]);
  const reopened = new HostStore({ dataDir: dir });
  reopened.close();
});
