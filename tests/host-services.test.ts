import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { EngineDriver, NativeMcpServer } from "@dexter/engines";
import { HostError, HostStore, ShutdownIncompleteError } from "@dexter/hub";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };

test("MCP requires enabled engines before creating a canonical host", () => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-services-invalid-"));
  const absent = join(dir, "absent");
  try {
    assert.throws(() => new HostServices({ dataDir: absent, enableMcp: true }), HostError);
    assert.equal(existsSync(absent), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("host composition retains auxiliary services and writer until native cleanup resolves", { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-services-drain-"));
  let release = () => {};
  const closing = new Promise<void>(resolve => { release = resolve; });
  const servers: NativeMcpServer[] = [];
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    makeDriver(engine, options): EngineDriver {
      if (options.localMcpServer) servers.push(options.localMcpServer);
      return { id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
        async status() { return { engine, installed: true, version: "synthetic", authentication: "authenticated", billing: "subscription" }; },
        async open(threadId, cursor) { return { threadId, nativeCursor: cursor ?? "synthetic-cursor" }; },
        async *turn(session, turnId) { yield { type: "text.delta", threadId: session.threadId, turnId, text: "synthetic" };
          yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
        async respondToTool() {}, async interrupt() {}, async close() { await closing; },
      };
    },
  });
  t.after(async () => { release(); await services.shutdown({ graceMs: 2_000 }); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(services.upstreamConfigured, false);
  const runtime = services.runtime!;
  const bot = services.store.createBot({ name: "Composition fixture", profileId: "personal", engine: "claude" });
  const thread = services.store.createThread(bot.id);
  const { turn } = runtime.startTurn(thread.id, { clientRequestId: "compose", content: "synthetic" });
  await runtime.waitForTurn(turn.id);
  assert.equal(servers.length, 1);
  assert.deepEqual(services.gateway!.registry.listTools(), []);
  const order: string[] = [];
  const gatewayClose = services.gateway!.close.bind(services.gateway);
  services.gateway!.close = () => {
    assert.throws(() => new HostStore({ dataDir: dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
    order.push("gateway"); gatewayClose();
  };
  const storeClose = services.store.close.bind(services.store);
  services.store.close = () => { order.push("store"); storeClose(); };
  await assert.rejects(services.shutdown({ graceMs: 10 }), ShutdownIncompleteError);
  assert.deepEqual(order, []);
  assert.equal(services.gateway!.registry.listTools().length, 0, "gateway remains open while cleanup is unconfirmed");
  assert.throws(() => new HostStore({ dataDir: dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
  release();
  await Promise.all([services.shutdown({ graceMs: 2_000 }), services.shutdown({ graceMs: 2_000 })]);
  assert.deepEqual(order, ["gateway", "store"]);
  assert.equal(existsSync(servers[0]!.args[1]!), false);
  const reopened = new HostStore({ dataDir: dir }); reopened.close();
  await services.shutdown();
  assert.deepEqual(order, ["gateway", "store"]);
});
