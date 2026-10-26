import { mcpDirectoryClient } from "./fixtures/mcp-directory-client.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { EngineId } from "@dexter/contracts";
import type { EngineDriver, NativeMcpServer } from "@dexter/engines";
import { HostError, HostStore, ShutdownIncompleteError } from "@dexter/hub";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };

const memory = { origin: "http://127.0.0.1:1", labLoopbackWithoutAuth: true,
  fetch: async () => { throw new Error("unexpected fixture request"); } };
function driver(engine: EngineId, work?: (server: NativeMcpServer) => Promise<void>, server?: NativeMcpServer): EngineDriver {
  return { id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
    async status() { return { engine, installed: true, version: "synthetic", authentication: "authenticated", billing: "subscription" }; },
    async open(threadId, cursor) { return { threadId, nativeCursor: cursor ?? "fixture-cursor" }; },
    async *turn(session, turnId) {
      if (work) { assert.ok(server); await work(server); }
      yield { type: "text.delta", threadId: session.threadId, turnId, text: "context fixture" };
      yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} };
    }, async respondToTool() {}, async interrupt() {}, async close() {},
  };
}
function mcp(server: NativeMcpServer) {
  const child: ChildProcessWithoutNullStreams = spawn(server.command, [...server.args], { stdio: "pipe" });
  let sequence = 0; let buffer = ""; const replies = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.stderr.resume();
  const exited = new Promise<void>((done, reject) => {
    child.once("error", reject); child.once("close", () => { for (const waiter of replies.values()) waiter.reject(new Error("MCP child exited")); replies.clear(); done(); });
  });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"); const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      replies.get(row.id)?.resolve(row); replies.delete(row.id);
    }
  });
  const rpc = (method: string, params: unknown = {}) => {
    const id = ++sequence; const result = new Promise<any>((resolveReply, rejectReply) => replies.set(id, { resolve: resolveReply, reject: rejectReply }));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return result;
  };
  return { child, rpc, async init() {
    await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "host-context-fixture", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }, async close() { child.stdin.end(); await exited; } };
}

test("context rejects missing MCP/isolation before creating host files", () => {
  const dir = mkdtempSync(join(tmpdir(), "dx-host-context-invalid-")); const absent = join(dir, "absent");
  try {
    assert.throws(() => new HostServices({ dataDir: absent, context: { memory, ownerExclusiveDeployment: true } }), HostError);
    assert.throws(() => new HostServices({ dataDir: absent, enableEngines: true, enableMcp: true,
      context: { memory, ownerExclusiveDeployment: false } }), HostError);
    assert.equal(existsSync(absent), false);
    for (const origin of ["not-a-url", "http://10.0.0.5:9", "http://example.com", "http://127.0.0.1:1/x"]) {
      assert.throws(() => new HostServices({ dataDir: absent, enableEngines: true, enableMcp: true,
        context: { memory: { ...memory, origin }, ownerExclusiveDeployment: true } }),
      (error: unknown) => error instanceof HostError && error.code === "invalid_input");
      assert.equal(existsSync(absent), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("turn composition registers each context profile before native open and grants nothing", { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dx-host-context-registration-")); let nativeOpens = 0;
  const services: HostServicesType = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    context: { memory, ownerExclusiveDeployment: true }, makeDriver(engine, options) {
      if (options.localMcpServer) {
        nativeOpens++; assert.equal(services.gateway!.registry.listTools().length, 8);
        assert.equal(services.gateway!.registry.listConnections(`profile-${nativeOpens}`).length, 1);
        // First-party guides/proposals are now present; registering a legacy Context route still grants no access.
        const connection=services.gateway!.registry.listConnections(`profile-${nativeOpens}`)[0]!;
        for(const tool of services.gateway!.registry.listTools()) {
          const alias=`mcp__dexter_gateway__dx_${createHash('sha256').update(`${tool.manifest.name}\u0000${connection.id}`).digest('hex').slice(0,24)}`;
          assert.ok(!options.allowedMcpTools?.includes(alias),'ungranted legacy Context alias stays absent at native open');
        }
      }
      return driver(engine);
    },
  });
  t.after(async () => { await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(services.memorySync!.status().health, "unverified");
  for (let n = 1; n <= 2; n++) {
    const bot = services.store.createBot({ name: `Bot ${n}`, profileId: `profile-${n}`, engine: "claude" }); const thread = services.store.createThread(bot.id);
    const started = services.runtime!.startTurn(thread.id, { clientRequestId: `register-${n}`, content: "fixture" });
    await services.runtime!.waitForTurn(started.turn.id);
    assert.equal(services.store.getTurn(started.turn.id).state, "completed");
    assert.equal(services.store.getGrant(bot.id, "context.recall", services.gateway!.registry.listConnections(bot.profileId)[0]!.id), null);
    assert.equal(services.runtime!.startTurn(thread.id, { clientRequestId: `register-${n}`, content: "fixture" }).created, false);
  }
  assert.equal(nativeOpens, 2); assert.equal(services.context!.status().activeCapabilities, 0);
});

test("HostServices routes granted recall through its real Node MCP wrapper, with no authority widening", { timeout: 15_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dx-host-context-wrapper-")); let searches = 0; let page: ReturnType<NonNullable<HostServicesType["context"]>["createMemory"]>;
  let connectionId = ""; let calls = 0;
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    context: { ownerExclusiveDeployment: true, memory: { ...memory, fetch: async (_url, init) => {
      searches++; const body = JSON.parse(String(init.body));
      assert.equal(body.q, "fixture");
      return Response.json(body.scopes.some((scope: any) => scope.workspace === page.service.workspace && scope.project === page.service.project)
        ? [{ ...page.service, rank: -1, title: "discard", snippet: "discard" }] : []);
    } } },
    makeDriver(engine, options) { return driver(engine, async server => {
      calls++; const client = mcp(server);
      try {
        await client.init(); const tools = (await client.rpc("tools/list")).result.tools;
        const alias = `dx_${createHash("sha256").update(`context.recall\u0000${connectionId}`).digest("hex").slice(0, 24)}`;
        const directory=mcpDirectoryClient(client.rpc);const resolved=await directory.find("context.recall",alias);assert.equal(resolved.name,alias);
        for(const name of ['context.skills','context.artifact.create','context.artifact.read','context.artifact.revise','context.artifact.history','context.artifact.restore','context.artifact.fork']) {
          const ungranted=`dx_${createHash('sha256').update(`${name}\u0000${connectionId}`).digest('hex').slice(0,24)}`;
          assert.ok(!tools.some((tool:{name:string})=>tool.name===ungranted),'ungranted legacy Context aliases stay absent');
          const searched=(await client.rpc('tools/call',{name:'dx_catalog_search',arguments:{query:name}})).result;assert.ok(!searched.structuredContent.tools.some((t:{alias:string})=>t.alias===ungranted));
        }
        const args = { query: "fixture", locale: "pt-BR" };
        const first = (await directory.call(resolved,"recall-once",args)).result.structuredContent;
        assert.equal(first.status, "succeeded"); assert.equal(first.result.untrustedContext, true);
        assert.equal(first.result.instructionAuthority, "none"); assert.equal(first.result.data[0].markdown, "# Host canonical context");
        const before = searches;
        const again = (await directory.call(resolved,"recall-once",args)).result.structuredContent;
        assert.equal(again.actionId, first.actionId); assert.equal(searches, before);
      } finally { await client.close(); }
    }, options.localMcpServer); },
  });
  t.after(async () => { await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const bot = services.store.createBot({ name: "Reader", profileId: "personal", engine: "claude" }); const thread = services.store.createThread(bot.id);
  const connection = services.prepareContextProfile(bot.profileId); connectionId = connection.id;
  page = services.context!.createMemory({ scope: { kind: "global" }, locale: "pt-BR", classification: "context", markdown: "# Host canonical context", origin: "fixture" });
  services.store.setGrant({ botId: bot.id, tool: "context.recall", destination: connection.id, policy: "allow" });
  const { turn } = services.runtime!.startTurn(thread.id, { clientRequestId: "read", content: "fixture" });
  await services.runtime!.waitForTurn(turn.id);
  assert.equal(services.store.getTurn(turn.id).state, "completed"); assert.equal(calls, 1); assert.ok(searches > 0);
  assert.equal(services.context!.status().activeCapabilities, 0); assert.equal(services.memorySync!.jobs().length, 0, "recall does not automatically index");
});

test("rejected auxiliary close is permanently quarantined instead of releasing the writer on retry", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dx-host-context-quarantine-"));
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    context: { memory, ownerExclusiveDeployment: true }, makeDriver(engine) { return driver(engine); } });
  const realClose = services.memorySync!.close.bind(services.memorySync); let closes = 0;
  services.memorySync!.close = async () => { closes++; await realClose(); throw new Error("unconfirmed cleanup fixture"); };
  t.after(async () => { await services.memoryClient!.close(); services.context!.close(); services.gateway!.close(); services.store.close(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(services.shutdown(), ShutdownIncompleteError);
  await assert.rejects(services.shutdown(), ShutdownIncompleteError); assert.equal(closes, 1);
  assert.throws(() => new HostStore({ dataDir: dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
});

test("unsettled auxiliary cleanup bounds shutdown waits and retains all authority until positive drain", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dx-host-context-drain-"));
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    context: { memory, ownerExclusiveDeployment: true }, makeDriver(engine) { return driver(engine); } });
  let release = () => {}; const held = new Promise<void>(done => { release = done; });
  const realClose = services.memorySync!.close.bind(services.memorySync); let closes = 0;
  services.memorySync!.close = async () => { closes++; await held; await realClose(); };
  t.after(async () => { release(); await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(services.shutdown({ graceMs: 5 }), ShutdownIncompleteError);
  await assert.rejects(services.shutdown({ graceMs: 5 }), ShutdownIncompleteError); assert.equal(closes, 1);
  assert.equal(services.context!.status().activeCapabilities, 0); assert.deepEqual(services.gateway!.registry.listTools(), []);
  assert.throws(() => new HostStore({ dataDir: dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
  release(); await services.shutdown({ graceMs: 2_000 });
  const reopened = new HostStore({ dataDir: dir }); reopened.close();
});
