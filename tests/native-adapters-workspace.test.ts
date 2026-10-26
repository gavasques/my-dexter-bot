import { MCP_DIRECTORY_NAMES } from "./fixtures/mcp-directory-client.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Action, EngineId } from "@dexter/contracts";
import { GrokAcpDriver, MuseMspDriver, type EngineDriver, type EngineSession } from "@dexter/engines";
import { CapabilityGateway, SyntheticCredentialBroker, type AdapterCall, type GatewayCallResult } from "@dexter/gateway";
import { ConversationRuntime, HostStore } from "@dexter/hub";
import { WorkspaceDriver, type WorkspaceNativeOptions } from "../packages/cli/src/workspace-driver.js";

const wrapperPath = resolve("packages/cli/dist/mcp-stdio.js");
const syntheticHost = "native-workspace.example.test";
const syntheticCredential = "synthetic-native-workspace-credential";
const manifest = {
  name: "slack.send", toolkit: "slack", upstreamSlug: "SLACK_SEND", version: "v1", description: "Send synthetic message",
  upstreamHost: syntheticHost, effect: "write", destinationArgument: "channel",
  inputSchema: { type: "object", additionalProperties: false, required: ["channel"],
    properties: { channel: { type: "string", maxLength: 12, enum: ["C-ops"] } } },
};

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Native workspace fixture deadline: ${description}`);
    await new Promise<void>(done => setTimeout(done, 2));
  }
}
interface NativeObservation {
  engine: EngineId;
  options: WorkspaceNativeOptions;
  driver: EngineDriver;
  session?: EngineSession;
  openCursors: Array<string | undefined>;
  turnInputs: string[];
  turnCalls: number;
  confirmedCloses: number;
}
interface ObservedReceipt { turnId: string; callId: string; value: GatewayCallResult }

for (const engine of ["grok", "muse"] as const) {
  test(`${engine}: native protocol crosses Workspace MCP approval, denial and replay with fresh leases`, { timeout: 30_000 }, async t => {
    // Every DB, workspace, CLI profile and credential belongs to this synthetic lab.
    const lab = realpathSync(mkdtempSync(join(tmpdir(), "dx-native-workspace-")));
    const dataDir = join(lab, "host"), syntheticHome = join(lab, "home"), profile = join(lab, "profile");
    mkdirSync(syntheticHome, { mode: 0o700 });
    const store = new HostStore({ dataDir });
    const broker = new SyntheticCredentialBroker();
    broker.put("synthetic-native", { headers: { authorization: syntheticCredential }, allowedHosts: [syntheticHost] });
    const effects: AdapterCall[] = [];
    const gateway = new CapabilityGateway({ store, broker, adapter: {
      async execute(call) { effects.push(call); return { ok: true, synthetic: true }; },
    } });
    gateway.registerTool(manifest);
    const bot = store.createBot({ name: `Synthetic ${engine}`, profileId: "work", engine });
    const thread = store.createThread(bot.id);
    const otherThread = store.createThread(bot.id);
    const otherBot = store.createBot({ name: `Other synthetic ${engine}`, profileId: "work", engine });
    const otherBotThread = store.createThread(otherBot.id);
    const excludedContext = [`foreign-thread-context-${engine}`, `foreign-bot-context-${engine}`,
      `api_key=synthetic-context-key-${engine}`, `Bearer synthetic-context-bearer-${engine}`];
    store.appendMessage(otherThread.id, { clientMessageId: randomUUID(), content: excludedContext[0]! });
    store.appendMessage(otherBotThread.id, { clientMessageId: randomUUID(), content: excludedContext[1]! });
    store.appendMessage(thread.id, { clientMessageId: randomUUID(), content: excludedContext[2]! });
    const connection = gateway.connectAccount({ profileId: "work", toolkit: "slack", label: "Synthetic Work",
      upstreamAccountRef: "ca_synthetic_work", credentialRef: "synthetic-native", allowedHosts: [syntheticHost] });
    store.setGrant({ botId: bot.id, tool: manifest.name, destination: connection.id, policy: "ask" });

    // Observe the real capability and receipt seams without replacing host decisions or native drivers.
    const capabilities: Array<{ token: string; turnId: string }> = [];
    const issue = gateway.issueCapability.bind(gateway);
    gateway.issueCapability = input => {
      const issued = issue(input); capabilities.push({ token: issued.token, turnId: issued.scope.turnId }); return issued;
    };
    const receipts: ObservedReceipt[] = [];
    const call = gateway.call.bind(gateway);
    gateway.call = async (token, input, options) => {
      const receipt = await call(token, input, options);
      const scope = capabilities.find(value => value.token === token);
      assert.ok(scope, "receipt must use a capability issued by this host");
      const callId = (input as { callId?: unknown }).callId;
      assert.equal(typeof callId, "string");
      receipts.push({ turnId: scope.turnId, callId: callId as string, value: receipt });
      return receipt;
    };
    const natives: NativeObservation[] = [];
    const fixture = fileURLToPath(new URL(engine === "grok" ? "./fixtures/acp-protocol.js" : "./fixtures/muse-protocol.js", import.meta.url));
    const driver = new WorkspaceDriver(engine, store, dataDir, {
      mcp: { gateway, wrapperPath },
      makeDriver(selected, options) {
        assert.equal(selected, engine);
        const common = { ...options, command: process.execPath, prefixArgs: [fixture],
          env: { HOME: syntheticHome, DEXTER_FIXTURE_MODE: engine === "grok" ? "grok-gateway-host" : "gateway-host" },
          requestTimeoutMs: 3_000, turnTimeoutMs: 10_000, killGraceMs: 20 };
        const native: EngineDriver = engine === "grok"
          ? new GrokAcpDriver({ ...common, profileHome: profile })
          : new MuseMspDriver({ ...common, authConfigDirectory: profile });
        assert.equal(native.id, selected);
        assert.ok(engine === "grok" ? native instanceof GrokAcpDriver : native instanceof MuseMspDriver);
        const observation: NativeObservation = { engine: selected, options, driver: native,
          openCursors: [], turnInputs: [], turnCalls: 0, confirmedCloses: 0 };
        natives.push(observation);
        const open = native.open.bind(native), turn = native.turn.bind(native), close = native.close.bind(native);
        native.open = async (...args) => { observation.openCursors.push(args[1]); return observation.session = await open(...args); };
        native.turn = (...args) => { observation.turnCalls++; observation.turnInputs.push(args[2]); return turn(...args); };
        native.close = async session => { await close(session); observation.confirmedCloses++; };
        return native;
      },
    });
    const runtime = new ConversationRuntime({ store, drivers: [driver], turnTimeoutMs: 12_000, abortGraceMs: 200 });
    t.after(async () => {
      await runtime.shutdown({ graceMs: 3_000, closeStore: false });
      gateway.close(); store.close(); rmSync(lab, { recursive: true, force: true });
    });
    assert.equal(driver.sessionReuse, "turn");
    const callId = engine === "grok" ? "acp-host-receipt" : "msp-host-receipt";
    const expectedAlias = `mcp__dexter_gateway__dx_${createHash("sha256").update(`${manifest.name}\u0000${connection.id}`).digest("hex").slice(0, 24)}`;
    const actions: Action[] = [];
    const endpoints: string[] = [];
    let firstUser: string | undefined, firstResponse: string | undefined;

    for (const [index, decision] of (["allow", "deny"] as const).entries()) {
      if (index === 1) store.appendMessage(thread.id, { clientMessageId: randomUUID(), content: excludedContext[3]! });
      const input = { clientRequestId: randomUUID(), content: `Synthetic ${engine} action ${decision}` };
      const started = runtime.startTurn(thread.id, input);
      await until(() => receipts.some(value => value.turnId === started.turn.id && value.value.status === "awaiting_approval"), "host approval receipt");
      const pending = receipts.find(value => value.turnId === started.turn.id && value.value.status === "awaiting_approval")!;
      assert.equal(pending.callId, callId);
      const action = store.getAction(pending.value.actionId);
      assert.equal(action.state, "awaiting_approval");
      assert.equal(action.requestHash, pending.value.requestHash);
      assert.equal(action.request.botId, bot.id); assert.equal(action.request.threadId, thread.id);
      assert.equal(action.request.tool, manifest.name); assert.equal(action.request.destination, connection.id);
      assert.deepEqual(action.request.arguments.input, { channel: "C-ops" });
      assert.equal(effects.length, index === 0 ? 0 : 1, "awaiting approval must not dispatch an effect");
      actions.push(action);
      runtime.decideAction(action.id, { decision, requestHash: pending.value.requestHash });

      assert.equal((await runtime.waitForTurn(started.turn.id, 10_000)).state, "completed");
      await until(() => runtime.status().pending.sessions === 0 && runtime.status().pending.turns === 0, "owned native process and lease cleanup");
      const terminal = decision === "allow" ? "succeeded" : "denied";
      assert.equal(store.getAction(action.id).state, terminal);
      const turnReceipts = receipts.filter(value => value.turnId === started.turn.id);
      assert.equal(turnReceipts.at(-1)!.value.status, terminal);
      assert.ok(turnReceipts.every(value => value.callId === callId && value.value.actionId === action.id && value.value.requestHash === action.requestHash));
      const assistant = store.listMessages(thread.id).filter(message => message.role === "assistant").at(-1)!;
      assert.deepEqual(JSON.parse(assistant.content), { status: terminal, approvalPendingObserved: true });
      assert.equal(effects.length, 1, "allowed dispatches once; denied dispatches zero additional effects");

      const bound = natives.filter(value => value.options.localMcpServer !== undefined);
      assert.equal(bound.length, index + 1, "each turn gets a fresh native binding");
      const native = bound[index]!;
      assert.equal(native.engine, engine); assert.equal(native.turnCalls, 1); assert.equal(native.confirmedCloses, 1);
      assert.equal(native.driver.capabilities.resume, false);
      assert.deepEqual(native.openCursors, [undefined], "non-resumable native sessions never receive the stored cursor");
      assert.equal(native.turnInputs.length, 1);
      const nativeInput = native.turnInputs[0]!;
      assert.ok(nativeInput.includes(input.content), "the native driver receives the current user message");
      for (const excluded of [...excludedContext, syntheticCredential]) assert.ok(!nativeInput.includes(excluded), "context stays within this thread and omits credential-looking messages");
      if (index === 1) {
        assert.ok(firstUser !== undefined && firstResponse !== undefined);
        assert.ok(nativeInput.includes(JSON.stringify(firstUser)), "fresh native session receives the first user message as quoted context");
        assert.ok(nativeInput.includes(JSON.stringify(firstResponse)), "fresh native session receives its first assistant response as quoted context");
      } else {
        firstUser = input.content; firstResponse = assistant.content;
        assert.equal(store.getThreadSession(thread.id)?.nativeCursor, native.session!.nativeCursor,
          "a recorded cursor exists but must not be reused by a non-resumable adapter");
      }
      assert.deepEqual(new Set(native.options.allowedMcpTools), new Set([...MCP_DIRECTORY_NAMES.map(name=>`mcp__dexter_gateway__${name}`),expectedAlias]));
      assert.equal(native.options.cwd, join(dataDir, "workspaces", bot.id, thread.id));
      const server = native.options.localMcpServer!;
      assert.equal(server.command, process.execPath); assert.equal(server.args[0], wrapperPath); assert.equal(server.args.length, 2);
      const endpoint = server.args[1]!; endpoints.push(endpoint);
      assert.equal(existsSync(dirname(endpoint)), false, "fresh lease directory is removed only after native cleanup");
      const issued = capabilities.find(value => value.turnId === started.turn.id)!;
      assert.throws(() => gateway.listTools(issued.token), "completed turn capability is revoked");

      const beforeReplay = { nativeTurns: natives.reduce((count, value) => count + value.turnCalls, 0), nativeBindings: bound.length,
        effects: effects.length, receipts: receipts.length, messages: store.listMessages(thread.id).length };
      const replay = runtime.startTurn(thread.id, input);
      assert.equal(replay.turn.id, started.turn.id); assert.equal(replay.turn.state, "completed");
      assert.deepEqual({ nativeTurns: natives.reduce((count, value) => count + value.turnCalls, 0),
        nativeBindings: natives.filter(value => value.options.localMcpServer !== undefined).length,
        effects: effects.length, receipts: receipts.length, messages: store.listMessages(thread.id).length }, beforeReplay,
      "same client request returns the durable turn without native inference or MCP dispatch");
    }
    assert.notEqual(actions[0]!.id, actions[1]!.id);
    assert.notEqual(endpoints[0], endpoints[1]);
    assert.equal(capabilities.length, 2); assert.notEqual(capabilities[0]!.token, capabilities[1]!.token);
    assert.deepEqual(store.listActions().map(action => action.state), ["succeeded", "denied"]);
    assert.equal(effects[0]!.scope.turnId, capabilities[0]!.turnId);
    assert.equal(effects[0]!.scope.botId, bot.id); assert.equal(effects[0]!.scope.threadId, thread.id);
    assert.equal(effects[0]!.connectionId, connection.id); assert.deepEqual(effects[0]!.arguments, { channel: "C-ops" });
    const exposed = JSON.stringify({ options: natives.map(value => value.options), messages: store.listMessages(thread.id), actions: store.listActions() });
    assert.ok(!exposed.includes(syntheticCredential));
    for (const issued of capabilities) assert.ok(!exposed.includes(issued.token));
    assert.equal(existsSync(wrapperPath), true, "the integration uses the built real stdio wrapper");
  });
}
