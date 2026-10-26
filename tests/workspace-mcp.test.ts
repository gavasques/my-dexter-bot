import { MCP_DIRECTORY_NAMES } from "./fixtures/mcp-directory-client.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { EngineId, JsonValue } from "@dexter/contracts";
import { EngineError, type EngineDriver, type EngineEvent, type EngineSession } from "@dexter/engines";
import { CapabilityGateway, SyntheticCredentialBroker, type AdapterCall } from "@dexter/gateway";
import { ConversationRuntime, HostError, HostStore, ShutdownIncompleteError } from "@dexter/hub";
import { WorkspaceDriver, type WorkspaceNativeOptions } from "../packages/cli/src/workspace-driver.js";

const wrapperPath = resolve("packages/cli/dist/mcp-stdio.js");
const secret = "synthetic-workspace-secret";
const host = "backend.example.test";
const tool = { name: "slack.send", toolkit: "slack", upstreamSlug: "SLACK_SEND", version: "v1", description: "Send", upstreamHost: host, effect: "write", destinationArgument: "channel", inputSchema: { type: "object", additionalProperties: false, required: ["channel"], properties: { channel: { type: "string", maxLength: 12, enum: ["C-ops"] } } } };
const gate = () => { let release = () => {}; const promise = new Promise<void>(resolveDone => { release = resolveDone; }); return { promise, release: () => release() }; };
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(check: () => boolean) { const end = Date.now() + 5_000; while (!check()) { if (Date.now() > end) throw new Error("fixture deadline"); await delay(2); } }
type Ctx = { after(fn: () => void | Promise<void>): void };

/** A native-engine fixture actually speaks stdio MCP to the private host wrapper. */
class Rpc {
  readonly child; readonly exited: Promise<void>;
  private seq = 0; private pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>();
  constructor(server: NonNullable<WorkspaceNativeOptions["localMcpServer"]>) {
    this.child = spawn(server.command, [...server.args], { shell: false, stdio: "pipe", env: { PATH: "/usr/bin:/bin" } });
    let buffer = "";
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("data", value => {
      buffer += value.toString();
      while (buffer.includes("\n")) { const n = buffer.indexOf("\n"); const msg = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); const waiter = this.pending.get(msg.id); if (waiter) { this.pending.delete(msg.id); msg.error ? waiter.reject(new EngineError("protocol_error")) : waiter.resolve(msg.result); } }
    });
    this.exited = new Promise(done => this.child.once("close", () => { for (const waiter of this.pending.values()) waiter.reject(new EngineError("session_closed")); this.pending.clear(); done(); }));
    this.child.once("error", () => { for (const waiter of this.pending.values()) waiter.reject(new EngineError("engine_unavailable")); this.pending.clear(); });
  }
  rpc(method: string, params?: unknown): Promise<any> { const id = ++this.seq; const promise = new Promise<any>((resolveDone, reject) => this.pending.set(id, { resolve: resolveDone, reject })); this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); return promise; }
  async init() { await this.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "workspace-fixture", version: "1" } }); this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); }
  async close() { this.child.stdin.end(); await this.exited; }
}
class NativeFixture implements EngineDriver {
  readonly capabilities = { resume: true, interrupt: true, fork: false, steer: false };
  session?: EngineSession; resumed: string | undefined; rpc?: Rpc; alias = ""; closes = 0; interrupts = 0;
  openGate?: ReturnType<typeof gate>; closeGate?: ReturnType<typeof gate>; closeError = false; failOpen = false; openingEffect = false;
  receipts: any[] = []; approvalGate?: ReturnType<typeof gate>;
  onInterrupt?: () => void; onPending?: () => Promise<void>;
  constructor(readonly id: EngineId, readonly options: WorkspaceNativeOptions) {}
  async status() { return { engine: this.id, installed: true, version: "fixture", authentication: "authenticated" as const, billing: "subscription" as const }; }
  async open(threadId: string, nativeCursor?: string) {
    this.resumed = nativeCursor;
    if (this.options.localMcpServer) { this.rpc = new Rpc(this.options.localMcpServer); await this.rpc.init(); this.alias = (await this.rpc.rpc("tools/list")).tools[0]?.name ?? ""; }
    if (this.openingEffect) { void this.rpc!.rpc("tools/call", { name: this.alias, arguments: { callId: "opening", input: { channel: "C-ops" } } }).catch(() => {}); await this.onPending!(); }
    await this.openGate?.promise;
    if (this.failOpen) { if (this.onPending) { void this.rpc!.rpc("tools/call", { name: this.alias, arguments: { callId: "opening", input: { channel: "C-ops" } } }).catch(() => {}); await this.onPending(); } await this.rpc?.close(); throw new EngineError("engine_unavailable"); }
    return this.session = { threadId, nativeCursor: nativeCursor ?? randomUUID() };
  }
  async *turn(session: EngineSession, turnId: string, input: string, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const call = () => this.rpc!.rpc("tools/call", { name: this.alias, arguments: { callId: "send", input: { channel: "C-ops" } } });
    if (input === "approval") { this.receipts.push((await call()).structuredContent); this.receipts.push((await call()).structuredContent); }
    if (input === "pending-complete") { void call().catch(() => {}); await this.onPending!(); }
    if (input === "pending-cancel") { try { await call(); } catch (error) { if (!signal.aborted) throw error; } }
    if (signal.aborted) { yield { type: "turn.interrupted", threadId: session.threadId, turnId }; return; }
    yield { type: "text.delta", threadId: session.threadId, turnId, text: "fixture result" };
    session.nativeCursor = randomUUID();
    yield { type: "turn.completed", threadId: session.threadId, turnId, usage: null };
  }
  async respondToTool(_session: EngineSession, _turnId: string, _requestId: string, _result: JsonValue) {}
  async interrupt() { this.interrupts++; this.onInterrupt?.(); }
  async close() { this.closes++; await this.closeGate?.promise; await this.rpc?.close(); if (this.closeError) throw new EngineError("protocol_error"); }
}
function setup(t: Ctx, id: EngineId = "claude", enabled = true, quarantinedClose = false) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-workspace-mcp-")); const store = new HostStore({ dataDir: dir });
  const broker = new SyntheticCredentialBroker(); broker.put("cred", { headers: { authorization: secret }, allowedHosts: [host] });
  let pendingEffects = 0; const calls: AdapterCall[] = []; let execute = async (_signal: AbortSignal): Promise<JsonValue> => ({ ok: true });
  const gateway = new CapabilityGateway({ store, broker, adapter: { async execute(call, _auth, context) { calls.push(call); pendingEffects++; try { return await execute(context.signal); } finally { pendingEffects--; } } } }); gateway.registerTool(tool);
  const bot = store.createBot({ name: "Fixture", profileId: "work", engine: id }); const thread = store.createThread(bot.id);
  const connection = gateway.connectAccount({ profileId: "work", toolkit: "slack", label: "Work", upstreamAccountRef: "ca_work", credentialRef: "cred", allowedHosts: [host] });
  const grant = (policy: "allow" | "ask" | "deny") => store.setGrant({ botId: bot.id, tool: tool.name, destination: connection.id, policy }); grant("allow");
  const tokens: string[] = []; const issue = gateway.issueCapability.bind(gateway); gateway.issueCapability = input => { const issued = issue(input); tokens.push(issued.token); return issued; };
  const natives: NativeFixture[] = []; const gates: ReturnType<typeof gate>[] = []; let configure = (_native: NativeFixture) => {};
  const driver = new WorkspaceDriver(id, store, dir, { ...(enabled ? { mcp: { gateway, wrapperPath } } : {}), makeDriver(engine, options) { const native = new NativeFixture(engine, options); if(options.cwd!==undefined){configure(native);natives.push(native);} return native; } });
  const runtime = new ConversationRuntime({ store, drivers: [driver], abortGraceMs: 15 });
  t.after(async () => {
    for (const g of gates) g.release();
    for (const native of natives) { native.openGate?.release(); native.closeGate?.release(); native.approvalGate?.release(); }
    if (quarantinedClose) {
      await assert.rejects(runtime.shutdown({ graceMs: 100, closeStore: false }), ShutdownIncompleteError);
      // Fixture-only disposal: the runtime correctly remains quarantined. Independently
      // verify every child and adapter has ended before disposing this synthetic store.
      await Promise.all(natives.map(native => native.rpc?.exited));
      await until(() => pendingEffects === 0);
      assert.equal(pendingEffects, 0); assert.ok(natives.every(native => native.rpc !== undefined && native.rpc.child.exitCode !== null));
    } else await runtime.shutdown({ graceMs: 2_000, closeStore: false });
    gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const start = (content: string) => runtime.startTurn(thread.id, { clientRequestId: randomUUID(), content }).turn;
  return { dir, store, gateway, bot, thread, connection, grant, tokens, natives, driver, runtime, start, gates, configure: (fn: typeof configure) => { configure = fn; }, setExecute: (fn: typeof execute) => { execute = fn; }, calls };
}

test("workspace without MCP retains one native session per thread", async t => {
  const f = setup(t, "claude", false); assert.equal(f.driver.sessionReuse, "thread");
  for (let n = 0; n < 2; n++) assert.equal((await f.runtime.waitForTurn(f.start("plain").id)).state, "completed");
  assert.equal(f.natives.length, 1); assert.equal(f.natives[0]!.options.cwd, join(f.dir, "workspaces", f.bot.id, f.thread.id));
  assert.equal(f.natives[0]!.options.localMcpServer, undefined); assert.equal(f.natives[0]!.closes, 0);
  await f.runtime.shutdown({ graceMs: 500, closeStore: false }); assert.equal(f.natives[0]!.closes, 1);
});
for (const engine of ["claude", "codex"] as const) test(`${engine} workspace MCP uses fresh per-turn endpoint and confirmed native resume cursor`, async t => {
  const f = setup(t, engine); assert.equal(f.driver.sessionReuse, "turn");
  const first = f.start("plain"); assert.equal((await f.runtime.waitForTurn(first.id)).state, "completed"); await until(() => f.natives[0]?.closes === 1 && f.runtime.status().pending.sessions === 0);
  const cursor = f.store.getThreadSession(f.thread.id)!.nativeCursor;
  const socket1 = f.natives[0]!.options.localMcpServer!.args[1]!; assert.equal(existsSync(dirname(socket1)), false);
  const second = f.start("plain"); assert.equal((await f.runtime.waitForTurn(second.id)).state, "completed"); await until(() => f.natives[1]?.closes === 1 && f.runtime.status().pending.sessions === 0);
  assert.equal(f.natives.length, 2); assert.equal(f.natives[1]!.resumed, cursor); assert.notEqual(f.natives[1]!.options.localMcpServer!.args[1], socket1);
  for (const native of f.natives) { assert.equal(native.options.localMcpServer!.command, process.execPath); assert.equal(native.options.localMcpServer!.args[0], wrapperPath); assert.equal(native.options.allowedMcpTools?.length, engine === "claude" ? 4 : undefined); if(engine==="claude")assert.deepEqual(new Set(native.options.allowedMcpTools),new Set([...MCP_DIRECTORY_NAMES,native.alias].map(name=>`mcp__dexter_gateway__${name}`))); assert.equal(native.rpc!.child.spawnargs.length, 3); }
  const exposed = JSON.stringify(f.natives.map(n => n.options)); assert.ok(!exposed.includes(secret)); for (const token of f.tokens) { assert.ok(!exposed.includes(token)); assert.throws(() => f.gateway.listTools(token)); }
});
test("actual wrapper approval hash and same-call polling dispatch exactly once in the claimed turn", async t => {
  const f = setup(t); f.grant("ask"); const approval = gate(); f.gates.push(approval); f.configure(native => { native.approvalGate = approval; });
  const turn = f.start("approval"); await until(() => f.store.listActions("awaiting_approval").length === 1); const pendingAction=f.store.listActions("awaiting_approval")[0]!;const pending={actionId:pendingAction.id,requestHash:pendingAction.requestHash};
  const other = f.store.createTurn(f.thread.id, { clientRequestId: "wrong-target", content: "plain" }).turn;
  const session = f.natives[0]!.session!;
  assert.throws(() => f.driver.turn(session, other.id, "plain", new AbortController().signal), EngineError);
  assert.throws(() => f.driver.respondToTool(session, other.id, "request", null), EngineError);
  await assert.rejects(f.driver.interrupt(session, other.id), EngineError); assert.equal(f.natives[0]!.interrupts, 0); assert.equal(f.gateway.listTools(f.tokens[0]!).length, 1);
  assert.equal(f.store.getAction(pending.actionId).requestHash, pending.requestHash); assert.throws(() => f.store.decideAction(pending.actionId, { decision: "allow", requestHash: "invalid" }));
  f.store.decideAction(pending.actionId, { decision: "allow", requestHash: pending.requestHash }); approval.release();
  assert.equal((await f.runtime.waitForTurn(turn.id)).state, "completed"); assert.equal(f.calls.length, 1); assert.deepEqual(f.natives[0]!.receipts.map(r => r.status), ["succeeded", "succeeded"]);
  assert.equal(f.calls[0]!.scope.turnId, turn.id); assert.equal(f.calls[0]!.scope.threadId, f.thread.id); assert.equal(f.calls[0]!.scope.botId, f.bot.id); assert.equal(f.calls[0]!.connectionId, f.connection.id);
});
test("cancel revokes before native interrupt; noncooperative MCP effect retains writer until drain", async t => {
  const f = setup(t); const effect = gate(); f.gates.push(effect); let signal: AbortSignal | undefined;
  const observed: { refused: boolean; aborted: boolean }[] = [];
  f.setExecute(async abort => { signal = abort; await effect.promise; return { ok: true }; });
  f.configure(native => { native.onInterrupt = () => { let refused = false; try { f.gateway.listTools(f.tokens[0]!); } catch { refused = true; } observed.push({ refused, aborted: signal?.aborted === true }); }; });
  const turn = f.start("pending-cancel"); await until(() => f.calls.length === 1); f.runtime.cancelTurn(turn.id);
  await f.runtime.waitForTurn(turn.id); await until(() => f.runtime.status().pending.sessions > 0);
  assert.ok(observed.length > 0); assert.ok(observed.every(value => value.refused && value.aborted));
  await assert.rejects(f.runtime.shutdown({ graceMs: 20, closeStore: false }), ShutdownIncompleteError);
  assert.throws(() => new HostStore({ dataDir: f.dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
  const socket = f.natives[0]!.options.localMcpServer!.args[1]!; assert.ok(existsSync(join(dirname(socket), "mcp.json")) || existsSync(dirname(socket)));
  effect.release(); await f.runtime.shutdown({ graceMs: 1_000, closeStore: false }); assert.equal(f.calls.length, 1); assert.equal(existsSync(dirname(socket)), false); assert.equal(f.natives[0]!.interrupts > 0, true);
});
test("native close rejection retains quarantine even after MCP residue drains; repeated close shares promise", async t => {
  const f = setup(t, "claude", true, true); const effect = gate(); f.gates.push(effect); f.setExecute(async () => { await effect.promise; return { ok: true }; });
  f.configure(native => { if (!f.natives.length) { native.closeError = true; native.onPending = () => until(() => f.calls.length === 1); } });
  const first = f.start("pending-complete"); const second = f.start("plain"); await f.runtime.waitForTurn(first.id); await until(() => f.natives[0]!.closes === 1);
  const native = f.natives[0]!; const closing = f.driver.close(native.session!); assert.equal(f.driver.close(native.session!), closing); const handled = closing.catch(() => {});
  await delay(30); assert.equal(f.store.getTurn(second.id).state, "queued"); assert.equal(f.natives.length, 1); assert.equal(native.closes, 1); assert.equal(f.runtime.status().pending.sessions > 0, true);
  effect.release(); await handled; await native.rpc!.exited;
  await until(() => f.runtime.status().pending.turns === 0);
  assert.equal(existsSync(dirname(native.options.localMcpServer!.args[1]!)), false);
  assert.equal(f.calls.length, 1); assert.equal(f.natives.length, 1);
  for (let n = 0; n < 2; n++) {
    assert.equal(f.store.getTurn(second.id).state, "queued"); assert.equal(f.runtime.status().pending.sessions, 1);
    await assert.rejects(f.runtime.shutdown({ graceMs: 20, closeStore: false }), ShutdownIncompleteError);
    assert.throws(() => new HostStore({ dataDir: f.dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
  }
  assert.equal(native.closes, 1, "failed native close is never retried or converted into success");
});
test("MCP open rejects absent context, queued turn and wrong thread before creating authority", async t => {
  const f = setup(t); await assert.rejects(f.driver.open(f.thread.id));
  const queued = f.store.createTurn(f.thread.id, { clientRequestId: "queued", content: "plain" }).turn; const signal = new AbortController().signal;
  await assert.rejects(f.driver.open(f.thread.id, undefined, { turnId: queued.id, signal }));
  f.store.claimNextTurn(f.thread.id); const other = f.store.createThread(f.bot.id); await assert.rejects(f.driver.open(other.id, undefined, { turnId: queued.id, signal }));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(f.driver.open(f.thread.id, undefined, { turnId: queued.id, signal: aborted.signal }));
  assert.equal(f.natives.length, 0); assert.equal(f.tokens.length, 0);
});
test("late open cancellation awaits native close and lease cleanup before rejection", async t => {
  const f = setup(t); const opening = gate(); const closing = gate(); f.gates.push(opening, closing); f.configure(native => { native.openGate = opening; native.closeGate = closing; });
  const turn = f.store.createTurn(f.thread.id, { clientRequestId: "direct", content: "plain" }).turn; f.store.claimNextTurn(f.thread.id); const abort = new AbortController();
  let settled = false; const pending = f.driver.open(f.thread.id, undefined, { turnId: turn.id, signal: abort.signal }).then(() => { settled = true; throw new Error("unexpected open"); }, error => { settled = true; assert.ok(error instanceof EngineError); });
  await until(() => !!f.natives[0]?.rpc && !!f.natives[0]?.alias); const socket = f.natives[0]!.options.localMcpServer!.args[1]!; const config = JSON.parse(readFileSync(join(dirname(socket), "mcp.json"), "utf8")); assert.equal(config.mcpServers.dexter_gateway.env, undefined);
  abort.abort(); opening.release(); await until(() => f.natives[0]!.closes === 1); await delay(20); assert.equal(settled, false); closing.release(); await pending; assert.equal(existsSync(dirname(socket)), false); assert.throws(() => f.gateway.listTools(f.tokens[0]!));
});
test("native open failure cleans its process and the turn lease without fabricating a session", async t => {
  const f = setup(t); f.configure(native => { native.failOpen = true; }); const turn = f.start("plain"); assert.equal((await f.runtime.waitForTurn(turn.id)).state, "failed");
  await until(() => f.runtime.status().pending.sessions === 0); const native = f.natives[0]!; await native.rpc!.exited; assert.equal(native.session, undefined); assert.equal(native.closes, 0); assert.equal(existsSync(dirname(native.options.localMcpServer!.args[1]!)), false); assert.throws(() => f.gateway.listTools(f.tokens[0]!));
});

test("failed native open still drains upstream residue before runtime releases writer", async t => {
  const f = setup(t); const effect = gate(); f.gates.push(effect); f.setExecute(async () => { await effect.promise; return { ok: true }; });
  f.configure(native => { native.failOpen = true; native.onPending = () => until(() => f.calls.length === 1); });
  const turn = f.start("plain"); await until(() => f.calls.length === 1); await until(() => f.natives[0]!.rpc!.child.exitCode !== null);
  await assert.rejects(f.runtime.shutdown({ graceMs: 20, closeStore: false }), ShutdownIncompleteError);
  assert.throws(() => new HostStore({ dataDir: f.dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
  const socket = f.natives[0]!.options.localMcpServer!.args[1]!; assert.equal(existsSync(dirname(socket)), true); assert.equal(f.natives[0]!.closes, 0);
  effect.release(); await f.runtime.shutdown({ graceMs: 1_000, closeStore: false }); assert.equal(existsSync(dirname(socket)), false); assert.equal(f.calls.length, 1); assert.notEqual(f.store.getTurn(turn.id).state, "completed");
});

test("direct interrupt revokes MCP before native interrupt even without context abort", async t => {
  const f = setup(t); const effect = gate(); f.gates.push(effect); let adapterSignal: AbortSignal | undefined;
  const observations: { refused: boolean; aborted: boolean }[] = [];
  f.setExecute(async signal => { adapterSignal = signal; await effect.promise; return { ok: true }; });
  f.configure(native => { native.onInterrupt = () => { let refused = false; try { f.gateway.listTools(f.tokens[0]!); } catch { refused = true; } observations.push({ refused, aborted: adapterSignal?.aborted === true }); }; });
  const turn = f.store.createTurn(f.thread.id, { clientRequestId: "direct-interrupt", content: "plain" }).turn; f.store.claimNextTurn(f.thread.id);
  const context = new AbortController(); const session = await f.driver.open(f.thread.id, undefined, { turnId: turn.id, signal: context.signal });
  try {
  const stream = f.driver.turn(session, turn.id, "pending-cancel", context.signal)[Symbol.asyncIterator]();
  const next = stream.next().then(() => null, error => error);
  await until(() => f.calls.length === 1); assert.equal(context.signal.aborted, false);
  await f.driver.interrupt(session, turn.id);
  assert.equal(context.signal.aborted, false); assert.deepEqual(observations, [{ refused: true, aborted: true }]);
  assert.throws(() => f.driver.turn(session, turn.id, "plain", context.signal), EngineError);
  assert.ok(await next instanceof EngineError);
  const closing = f.driver.close(session); let closed = false; const checked = closing.then(() => { closed = true; });
  await delay(20); assert.equal(closed, false); effect.release(); await checked; assert.equal(f.calls.length, 1);
  } finally { effect.release(); await f.driver.close(session); }
});

test("failed native open preserves engine error after settled cleanup failure and retains unexpected files", async t => {
  const f = setup(t); const opening = gate(); f.gates.push(opening); f.configure(native => { native.failOpen = true; native.openGate = opening; });
  const turn = f.store.createTurn(f.thread.id, { clientRequestId: "open-cleanup-failure", content: "plain" }).turn; f.store.claimNextTurn(f.thread.id);
  const pending = f.driver.open(f.thread.id, undefined, { turnId: turn.id, signal: new AbortController().signal });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof EngineError && error.code === "engine_unavailable");
  await until(() => !!f.natives[0]?.alias); const dir = dirname(f.natives[0]!.options.localMcpServer!.args[1]!); const foreign = join(dir, "unexpected.txt"); writeFileSync(foreign, "preserve");
  try { opening.release(); await rejected; await f.natives[0]!.rpc!.exited; assert.equal(readFileSync(foreign, "utf8"), "preserve"); assert.equal(f.natives[0]!.closes, 0); assert.throws(() => f.gateway.listTools(f.tokens[0]!)); }
  finally { opening.release(); await pending.catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test("late aborted open with rejected native close stays quarantined after MCP effect settles", async t => {
  const f = setup(t, "claude", true, true); const opening = gate(); const effect = gate(); f.gates.push(opening, effect);
  f.setExecute(async () => { await effect.promise; return { ok: true }; });
  f.configure(native => { native.openingEffect = true; native.openGate = opening; native.closeError = true; native.onPending = () => until(() => f.calls.length === 1); });
  const first = f.start("plain"); const queued = f.start("plain"); await until(() => f.calls.length === 1);
  f.runtime.cancelTurn(first.id); const terminal = await f.runtime.waitForTurn(first.id);
  assert.deepEqual([terminal.state, terminal.code], ["interrupted", "cancelled"]);
  opening.release(); await until(() => f.natives[0]!.closes === 1); const native = f.natives[0]!;
  assert.equal(f.runtime.status().pending.sessions, 1); assert.equal(f.store.getTurn(queued.id).state, "queued");
  await assert.rejects(f.runtime.shutdown({ graceMs: 20, closeStore: false }), ShutdownIncompleteError);
  effect.release(); await native.rpc!.exited;
  await until(() => !existsSync(dirname(native.options.localMcpServer!.args[1]!)));
  for (let n = 0; n < 2; n++) {
    await assert.rejects(f.runtime.shutdown({ graceMs: 20, closeStore: false }), ShutdownIncompleteError);
    assert.equal(f.runtime.status().pending.sessions, 1); assert.equal(f.store.getTurn(queued.id).state, "queued");
    assert.throws(() => new HostStore({ dataDir: f.dir }), (error: unknown) => error instanceof HostError && error.code === "host_locked");
  }
  assert.equal(native.closes, 1); assert.equal(f.natives.length, 1); assert.equal(f.calls.length, 1);
});
