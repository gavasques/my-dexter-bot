import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue } from "@dexter/contracts";
import { dispatchAction, HostError, HostStore } from "@dexter/hub";
import {
  CapabilityGateway, GatewayError, GatewayRegistry, SyntheticCredentialBroker,
  type AdapterCall, type InjectedAuth, type UpstreamAdapter,
} from "@dexter/gateway";

type Ctx = { after: (fn: () => void) => void };
// Synthetic values only. Never real credentials.
const SECRET_KEY = "synthetic-composio-key-7f3a9c";
const SECRET_SESSION = "synthetic-session-header-b41e02";
const SECRET_BEARER = "synthetic-bearer-token-55aa";
const SECRET_SHORT = "q9z";
const HOST = "backend.composio.test";

const SEND = {
  name: "slack.send_message", toolkit: "slack", upstreamSlug: "SLACK_SEND_MESSAGE", version: "20260901",
  description: "Post a message to an allowed channel", upstreamHost: HOST, effect: "write",
  destinationArgument: "channel",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["channel", "text"],
    properties: {
      channel: { type: "string", maxLength: 32, enum: ["C-general", "C-ops"] },
      text: { type: "string", maxLength: 200, minLength: 1 },
      urgent: { type: "boolean" },
    },
  },
} as const;
const READ = {
  name: "slack.list_channels", toolkit: "slack", upstreamSlug: "SLACK_LIST_CHANNELS", version: "20260901",
  description: "List channels", upstreamHost: HOST, effect: "read", destinationArgument: null,
  inputSchema: { type: "object", additionalProperties: false, required: [], properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } },
} as const;

type Mode = "echo" | "throw_after_effect";
class FakeAdapter implements UpstreamAdapter {
  calls: AdapterCall[] = [];
  /** Whether the expected synthetic header reached the adapter; values are never recorded. */
  authSeen: boolean[] = [];
  effects = 0;
  mode: Mode = "echo";
  async execute(call: AdapterCall, auth: InjectedAuth): Promise<JsonValue> {
    this.calls.push(call);
    this.authSeen.push(auth.headers["x-api-key"] === SECRET_KEY);
    this.effects += 1;
    if (this.mode === "throw_after_effect") throw new Error(`upstream 502 while using ${SECRET_KEY}`);
    // A careless upstream echo: secret under a credential key and inside an innocuous string.
    return { ok: true, posted: call.arguments, authorization: `Bearer ${SECRET_KEY}`, note: `session=${SECRET_SESSION}` };
  }
}

function setup(t: Ctx, dir = mkdtempSync(join(tmpdir(), "dexter-gateway-"))) {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HostStore({ dataDir: dir });
  const broker = new SyntheticCredentialBroker();
  broker.put("cred-slack-work", { headers: { "x-api-key": SECRET_KEY, "x-session": SECRET_SESSION }, allowedHosts: [HOST] });
  broker.put("cred-slack-home", { headers: { "x-api-key": SECRET_KEY }, allowedHosts: [HOST] });
  broker.put("cred-other", { headers: { authorization: `Bearer ${SECRET_BEARER}`, "x-pin": SECRET_SHORT }, allowedHosts: [HOST] });
  const adapter = new FakeAdapter();
  const gateway = new CapabilityGateway({ store, broker, adapter });
  t.after(() => { gateway.close(); store.close(); });
  gateway.registerTool(SEND);
  gateway.registerTool(READ);
  const bot = store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const other = store.createBot({ name: "Home", profileId: "home", engine: "codex" });
  const work = gateway.connectAccount({
    profileId: "work", toolkit: "slack", label: "Work Slack", upstreamAccountRef: "ca_work_1",
    credentialRef: "cred-slack-work", allowedHosts: [HOST],
  });
  const work2 = gateway.connectAccount({
    profileId: "work", toolkit: "slack", label: "Second workspace", upstreamAccountRef: "ca_work_2",
    credentialRef: "cred-slack-work", allowedHosts: [HOST],
  });
  const home = gateway.connectAccount({
    profileId: "home", toolkit: "slack", label: "Home Slack", upstreamAccountRef: "ca_home_1",
    credentialRef: "cred-slack-home", allowedHosts: [HOST],
  });
  return { dir, store, broker, adapter, gateway, bot, other, work, work2, home };
}
function runningTurn(store: HostStore, botId: string, n = 1) {
  const thread = store.createThread(botId);
  const { turn } = store.createTurn(thread.id, { clientRequestId: `req-${n}`, content: "do it" });
  const running = store.claimNextTurn(thread.id);
  assert.equal(running?.id, turn.id);
  return { thread, turn };
}
function gwCode(expected: string) {
  return (error: unknown) => error instanceof GatewayError && error.code === expected;
}
const sendArgs = { channel: "C-general", text: "hello" };

test("a connected account grants nothing: no grant means no tools, no action and no upstream call", async (t) => {
  const { store, adapter, gateway, bot, work } = setup(t);
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  assert.deepEqual(gateway.listTools(token), []);
  await assert.rejects(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "c1", arguments: sendArgs }), gwCode("forbidden"));
  assert.equal(store.listActions().length, 0);
  assert.equal(adapter.calls.length, 0);

  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "allow" });
  assert.deepEqual(gateway.listTools(token).map((v) => [v.name, v.connectionId]), [[SEND.name, work.id]]);
  const done = await gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "c1", arguments: sendArgs });
  assert.equal(done.status, "succeeded");
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(adapter.authSeen, [true]);
  const call = adapter.calls[0]!;
  assert.equal(call.upstreamAccountRef, "ca_work_1");
  assert.equal(call.host, HOST);
  assert.equal(call.upstreamSlug, "SLACK_SEND_MESSAGE");
  assert.equal(call.upstreamUserId, `dx:${store.hostId}:${store.ownerId}:work`);
});

test("grants are per bot, tool and account: swapping tool, account, profile or principal is refused", async (t) => {
  const { store, adapter, gateway, bot, other, work, work2, home } = setup(t);
  store.setGrant({ botId: bot.id, tool: READ.name, destination: work.id, policy: "allow" });
  // Even a hub grant naming another profile's connection cannot make it usable to this bot.
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: home.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const attempt = (input: unknown) => gateway.call(token, input);

  await assert.rejects(attempt({ tool: SEND.name, connectionId: work.id, callId: "a", arguments: sendArgs }), gwCode("forbidden"), "other tool, same account");
  await assert.rejects(attempt({ tool: READ.name, connectionId: work2.id, callId: "b", arguments: {} }), gwCode("forbidden"), "same tool, other account");
  await assert.rejects(attempt({ tool: SEND.name, connectionId: home.id, callId: "c", arguments: sendArgs }), gwCode("forbidden"), "other profile's account");
  await assert.rejects(attempt({ tool: READ.name, connectionId: "conn_missing", callId: "d", arguments: {} }), gwCode("forbidden"));
  for (const extra of [{ botId: other.id }, { userId: "someone" }, { connectedAccountId: "ca_home_1" }, { toolkit: "gmail" }, { headers: { a: "b" } }]) {
    await assert.rejects(attempt({ tool: READ.name, connectionId: work.id, callId: "e", arguments: {}, ...extra }), gwCode("invalid_input"));
  }
  for (const args of [{ user_id: "x" }, { connected_account_id: "ca_home_1" }, { tool_slug: "GMAIL_SEND" }, { url: "https://evil.test" }]) {
    await assert.rejects(attempt({ tool: READ.name, connectionId: work.id, callId: "f", arguments: args }), gwCode("invalid_input"));
  }
  await assert.rejects(gateway.call("A".repeat(43), { tool: READ.name, connectionId: work.id, callId: "g", arguments: {} }), gwCode("unauthorized"));
  // A capability of the other bot sees only its own profile; the home bot has no grants at all.
  const homeCap = gateway.issueCapability({ turnId: runningTurn(store, other.id, 2).turn.id });
  assert.equal(homeCap.scope.profileId, "home");
  await assert.rejects(gateway.call(homeCap.token, { tool: READ.name, connectionId: work.id, callId: "h", arguments: {} }), gwCode("forbidden"));
  assert.equal(store.listActions().length, 0);
  assert.equal(adapter.calls.length, 0);
});

test("capabilities die with their turn, on revocation and on restart", async (t) => {
  const { dir, store, broker, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: READ.name, destination: work.id, policy: "allow" });
  const { turn } = runningTurn(store, bot.id);
  const first = gateway.issueCapability({ turnId: turn.id });
  const second = gateway.issueCapability({ turnId: turn.id });
  gateway.revokeCapability(first.token);
  await assert.rejects(gateway.call(first.token, { tool: READ.name, connectionId: work.id, callId: "x", arguments: {} }), gwCode("unauthorized"));
  store.finishTurn(turn.id, "completed", null);
  await assert.rejects(gateway.call(second.token, { tool: READ.name, connectionId: work.id, callId: "x", arguments: {} }), gwCode("unauthorized"));
  assert.throws(() => gateway.issueCapability({ turnId: turn.id }), gwCode("unauthorized"));
  const live = gateway.issueCapability({ turnId: runningTurn(store, bot.id, 2).turn.id });
  gateway.close();
  const reopened = new CapabilityGateway({ store, broker, adapter });
  t.after(() => reopened.close());
  assert.throws(() => reopened.listTools(live.token), gwCode("unauthorized"));
  // The registry is bound to its installation and owner.
  assert.throws(() => new GatewayRegistry(dir, "another-installation", store.ownerId, Date.now, (op) => store.withWriterLease(op)), gwCode("conflict"));
  assert.equal(adapter.calls.length, 0);
});

test("arguments are validated against the pinned schema before anything is persisted", async (t) => {
  const { store, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const bad: Array<Record<string, unknown>> = [
    { channel: "C-secret-board", text: "hi" }, // destination outside the allowlist
    { channel: "C-general" }, // missing required
    { channel: "C-general", text: "" },
    { channel: "C-general", text: "x".repeat(201) },
    { channel: "C-general", text: 42 },
    { channel: "C-general", text: "hi", urgent: "yes" },
    { channel: "C-general", text: "hi", extra: 1 },
    { channel: "C-general", text: "hi", password: "p" },
  ];
  for (const [i, args] of bad.entries()) {
    await assert.rejects(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: `bad-${i}`, arguments: args }), gwCode("invalid_input"));
  }
  assert.equal(store.listActions().length, 0);
  assert.equal(adapter.calls.length, 0);
});

test("opaque meta-tools and schemas able to pick principal, tool, code or URL are refused at registration", (t) => {
  const { gateway } = setup(t);
  const withSchema = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...READ, name: "slack.custom", upstreamSlug: "SLACK_CUSTOM", ...extra,
    inputSchema: { type: "object", additionalProperties: false, required: [], properties },
  });
  const str = { type: "string", maxLength: 100 };
  assert.throws(() => gateway.registerTool({ ...READ, name: "composio.multi_execute", upstreamSlug: "COMPOSIO_MULTI_EXECUTE_TOOL" }), gwCode("meta_tool_refused"));
  assert.throws(() => gateway.registerTool({ ...READ, name: "x.workbench", upstreamSlug: "COMPOSIO_REMOTE_WORKBENCH" }), gwCode("meta_tool_refused"));
  assert.throws(() => gateway.registerTool({ ...READ, name: "github.proxy", upstreamSlug: "GITHUB_PROXY_EXECUTE" }), gwCode("meta_tool_refused"));
  for (const key of ["tool_slug", "connected_account_id", "user_id", "toolkit", "code", "command", "headers"]) {
    assert.throws(() => gateway.registerTool(withSchema({ [key]: str })), gwCode("meta_tool_refused"), key);
  }
  assert.throws(() => gateway.registerTool(withSchema({ url: str })), gwCode("meta_tool_refused"));
  assert.throws(() => gateway.registerTool(withSchema({ url: str }, { destinationArgument: "url" })), gwCode("invalid_input"), "unrestricted destination");
  assert.throws(() => gateway.registerTool({ ...withSchema({ text: str }), inputSchema: { type: "object", properties: { text: str }, required: [] } }), gwCode("invalid_input"), "open schema");
  assert.throws(() => gateway.registerTool(withSchema({ payload: { type: "object" } })), gwCode("invalid_input"), "nested free-form object");
  assert.throws(() => gateway.registerTool(withSchema({ text: { type: "string" } })), gwCode("invalid_input"), "unbounded string");
  // A URL is acceptable only as the declared, required, restricted destination with explicit https origins.
  const hook = { type: "string", maxLength: 200, pattern: "^https://hooks\\.example\\.test/[a-z0-9]+$" };
  assert.throws(() => gateway.registerTool({
    ...withSchema({ url: hook }, { destinationArgument: "url" }),
    inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: hook } },
  }), gwCode("invalid_input"), "URL destination without origins");
  const ok = gateway.registerTool({
    ...withSchema({ url: hook }, { destinationArgument: "url", destinationOrigins: ["https://hooks.example.test"] }),
    inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", maxLength: 200, pattern: "^https://hooks\\.example\\.test/[a-z0-9]+$" } } },
  });
  assert.equal(ok.revision, 1);
});

test("approval is bound to the frozen request hash; deny never dispatches", async (t) => {
  const { store, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "ask" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const input = { tool: SEND.name, connectionId: work.id, callId: "ask-1", arguments: sendArgs };
  const pending = await gateway.call(token, input);
  assert.equal(pending.status, "awaiting_approval");
  assert.equal(gateway.listTools(token)[0]?.requiresApproval, true);
  await assert.rejects(gateway.call(token, { ...input, arguments: { channel: "C-ops", text: "hello" } }), gwCode("conflict"));
  assert.throws(() => store.decideAction(pending.actionId, { decision: "allow", requestHash: "0".repeat(64) }), (e: unknown) => e instanceof HostError && e.code === "conflict");
  assert.equal((await gateway.call(token, input)).status, "awaiting_approval", "replay before approval does not dispatch");
  store.decideAction(pending.actionId, { decision: "allow", requestHash: pending.requestHash });
  const done = await gateway.call(token, input);
  assert.equal(done.status, "succeeded");
  assert.deepEqual(adapter.calls.map((c) => c.arguments), [sendArgs]);
  assert.equal((await gateway.call(token, input)).status, "succeeded");
  assert.equal(adapter.effects, 1);

  const denied = await gateway.call(token, { ...input, callId: "ask-2" });
  store.decideAction(denied.actionId, { decision: "deny", requestHash: denied.requestHash });
  const after = await gateway.call(token, { ...input, callId: "ask-2" });
  assert.equal(after.status, "denied");
  assert.equal(after.reason, "user_denied");
  assert.equal(adapter.effects, 1);
});

test("revocation after planning and before dispatch prevents the upstream call", async (t) => {
  const { store, adapter, gateway, bot, work, work2 } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "ask" });
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work2.id, policy: "ask" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const plan = async (callId: string, connectionId = work.id) => {
    const input = { tool: SEND.name, connectionId, callId, arguments: sendArgs };
    const action = await gateway.call(token, input);
    store.decideAction(action.actionId, { decision: "allow", requestHash: action.requestHash });
    assert.equal(store.getAction(action.actionId).state, "ready");
    return input;
  };

  const grantChanged = await plan("rev-grant");
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "ask" }); // any write bumps the revision
  const blocked = await gateway.call(token, grantChanged);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "permission_changed");

  const repinned = await plan("rev-manifest");
  gateway.registerTool({ ...SEND, description: "Post a message (v2 schema)" });
  assert.equal((await gateway.call(token, repinned)).status, "blocked");

  const capRevoked = await plan("rev-cap", work2.id);
  const other = gateway.issueCapability({ turnId: runningTurn(store, bot.id, 2).turn.id });
  gateway.revokeCapability(token);
  await assert.rejects(gateway.call(token, capRevoked), gwCode("unauthorized"));
  const stranger = await gateway.call(other.token, capRevoked);
  assert.equal(stranger.status, "awaiting_approval", "another turn gets its own action and needs its own approval");
  const original = store.listActions("ready").find((a) => a.request.destination === work2.id)!;
  assert.notEqual(stranger.actionId, original.id);

  const connRevoked = await gateway.call(other.token, { ...capRevoked, callId: "rev-conn" });
  store.decideAction(connRevoked.actionId, { decision: "allow", requestHash: connRevoked.requestHash });
  assert.equal(gateway.revokeConnection(work2.id).status, "revoked");
  for (const id of [original.id, stranger.actionId, connRevoked.actionId]) assert.equal(store.getAction(id).state, "blocked");
  assert.equal((await gateway.call(other.token, { ...capRevoked, callId: "rev-conn" })).status, "blocked");
  await assert.rejects(gateway.call(other.token, { ...capRevoked, callId: "rev-new" }), gwCode("forbidden"));
  assert.equal(adapter.calls.length, 0);
});

test("a crash between a registry change and the withdrawal still never dispatches a stale pin", async (t) => {
  const { store, adapter, gateway, bot, work, work2 } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "ask" });
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work2.id, policy: "ask" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const approve = async (callId: string, connectionId: string) => {
    const input = { tool: SEND.name, connectionId, callId, arguments: sendArgs };
    const action = await gateway.call(token, input);
    store.decideAction(action.actionId, { decision: "allow", requestHash: action.requestHash });
    return input;
  };
  const a = await approve("crash-manifest", work.id);
  const b = await approve("crash-conn", work2.id);
  // Registry writes alone, as if the process died before withdrawPending ran.
  gateway.registry.registerTool({ ...SEND, description: "changed under the pending action" });
  assert.equal(store.listActions("ready").length, 2);
  assert.equal((await gateway.call(token, a)).status, "blocked");
  gateway.registry.registerTool(SEND);
  gateway.registry.revokeConnection(work2.id);
  assert.equal((await gateway.call(token, b)).status, "blocked");
  assert.equal(adapter.calls.length, 0);
});

test("a throw after the upstream effect is unknown and a retry never re-executes", async (t) => {
  const { store, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  adapter.mode = "throw_after_effect";
  const input = { tool: SEND.name, connectionId: work.id, callId: "boom", arguments: sendArgs };
  const first = await gateway.call(token, input);
  assert.equal(first.status, "unknown");
  assert.equal(first.reason, "executor_error");
  adapter.mode = "echo";
  const retry = await gateway.call(token, input);
  assert.equal(retry.status, "unknown");
  assert.equal(retry.actionId, first.actionId);
  await assert.rejects(dispatchAction(store, first.actionId, async () => ({ again: true })), (e: unknown) => e instanceof HostError && e.code === "conflict");
  assert.equal(adapter.effects, 1);
});

test("concurrent calls with the same callId execute once", async (t) => {
  const { store, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const input = { tool: SEND.name, connectionId: work.id, callId: "race", arguments: sendArgs };
  const results = await Promise.all([gateway.call(token, input), gateway.call(token, input), gateway.call(token, input)]);
  assert.equal(new Set(results.map((r) => r.actionId)).size, 1);
  assert.equal(adapter.effects, 1);
  assert.equal((await gateway.call(token, input)).status, "succeeded");
});

test("credentials are released only for the allowlisted host and only to the adapter", async (t) => {
  const { store, broker, adapter, gateway, bot, work } = setup(t);
  assert.equal(broker.acquire("cred-slack-work", "evil.example.test"), null);
  // A tool pinned to a host outside the connection's allowlist is not usable through that connection.
  gateway.registerTool({ ...READ, name: "slack.export", upstreamSlug: "SLACK_EXPORT", upstreamHost: "export.other.test" });
  store.setGrant({ botId: bot.id, tool: "slack.export", destination: work.id, policy: "allow" });
  store.setGrant({ botId: bot.id, tool: READ.name, destination: work.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  assert.deepEqual(gateway.listTools(token).map((v) => v.name), [READ.name]);
  await assert.rejects(gateway.call(token, { tool: "slack.export", connectionId: work.id, callId: "e1", arguments: {} }), gwCode("forbidden"));
  // A missing credential leaves the action ready and undispatched instead of guessing.
  broker.revoke("cred-slack-work");
  const input = { tool: READ.name, connectionId: work.id, callId: "nocred", arguments: { limit: 5 } };
  await assert.rejects(gateway.call(token, input), gwCode("unavailable"));
  const pending = store.listActions("ready");
  assert.equal(pending.length, 1);
  broker.put("cred-slack-work", { headers: { "x-api-key": SECRET_KEY }, allowedHosts: [HOST] });
  assert.equal((await gateway.call(token, input)).status, "succeeded");
  assert.equal(adapter.effects, 1);
});

test("engine-facing projections expose no upstream ids, hosts, credential refs or secrets", async (t) => {
  const { store, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const [view] = gateway.listTools(token);
  assert.deepEqual(Object.keys(view!).sort(), ["connectionId", "connectionLabel", "description", "effect", "inputSchema", "name", "requiresApproval"]);
  const result = await gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "p", arguments: sendArgs });
  assert.deepEqual(Object.keys(result).sort(), ["actionId", "reason", "requestHash", "result", "status"]);
  const visible = JSON.stringify([view, result]);
  for (const hidden of ["ca_work_1", "cred-slack-work", HOST, "SLACK_SEND_MESSAGE", SECRET_KEY, SECRET_SESSION]) {
    assert.ok(!visible.includes(hidden), `projection leaks ${hidden === SECRET_KEY || hidden === SECRET_SESSION ? "a secret" : hidden}`);
  }
  assert.deepEqual((result.result as Record<string, JsonValue>).authorization, "[redacted]");
  assert.equal((result.result as Record<string, JsonValue>).note, "session=[redacted]");
});

test("synthetic secrets never reach host storage, receipts, events or errors", async (t) => {
  const { dir, store, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "allow" });
  store.setGrant({ botId: bot.id, tool: READ.name, destination: work.id, policy: "ask" });
  const { turn } = runningTurn(store, bot.id);
  const { token } = gateway.issueCapability({ turnId: turn.id });
  const errors: string[] = [];
  const capture = async (p: Promise<unknown>) => { try { return await p; } catch (e) { errors.push(String(e), JSON.stringify(e)); return null; } };
  const results = [
    await capture(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "s1", arguments: sendArgs })),
    await capture(gateway.call(token, { tool: READ.name, connectionId: work.id, callId: "s2", arguments: { limit: 3 } })),
  ];
  adapter.mode = "throw_after_effect";
  results.push(await capture(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "s3", arguments: sendArgs })));
  await capture(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "s4", arguments: { channel: "C-general", text: "x", token: "t" } }));
  results.push(gateway.listTools(token));
  gateway.close();
  store.close();

  const reopened = new HostStore({ dataDir: dir });
  const observable = JSON.stringify([
    results, errors, reopened.listActions(), reopened.listEvents(0, 500),
    reopened.listTurnEvents({ turnId: turn.id }, 0, 500), reopened.summary(),
  ]);
  reopened.close();
  const bytes = readdirSync(dir).filter((f) => f.startsWith("dexter.sqlite") || f.startsWith("gateway.sqlite"))
    .map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
  for (const secret of [SECRET_KEY, SECRET_SESSION, SECRET_BEARER]) {
    assert.ok(!observable.includes(secret), "secret leaked into receipts, events or errors");
    assert.ok(!bytes.includes(secret), "secret leaked into host storage");
  }
  assert.ok(errors.length >= 2, "the refused call contributed an error message to the scan");
});

test("catalog and connection revisions persist across restart; revoked stays revoked", (t) => {
  const { dir, store, broker, adapter, gateway, work } = setup(t);
  const v2 = gateway.registerTool({ ...READ, description: "List channels (v2)" });
  assert.equal(v2.revision, 2);
  assert.equal(gateway.registerTool({ ...READ, description: "List channels (v2)" }).revision, 2, "identical re-pin is a no-op");
  gateway.revokeConnection(work.id);
  gateway.close();
  store.close();
  const store2 = new HostStore({ dataDir: dir });
  const gateway2 = new CapabilityGateway({ store: store2, broker, adapter });
  t.after(() => { gateway2.close(); store2.close(); });
  assert.equal(gateway2.registry.getTool(READ.name)?.revision, 2);
  const revoked = gateway2.registry.getConnection(work.id);
  assert.equal(revoked?.status, "revoked");
  assert.equal(revoked?.revision, 2);
  assert.ok(!readFileSync(join(dir, "gateway.sqlite")).toString("latin1").includes(SECRET_KEY));
});

function hostBytes(dir: string): string {
  return readdirSync(dir).filter((f) => f.startsWith("dexter.sqlite") || f.startsWith("gateway.sqlite"))
    .map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
}

test("arguments carrying a known credential are refused before anything is persisted or sent upstream", async (t) => {
  const { dir, store, adapter, gateway, bot, work } = setup(t);
  gateway.registerTool({
    ...READ, name: "slack.search", upstreamSlug: "SLACK_SEARCH",
    inputSchema: { type: "object", additionalProperties: false, required: ["terms"], properties: { terms: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 5 } } },
  });
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "allow" });
  store.setGrant({ botId: bot.id, tool: "slack.search", destination: work.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const errors: string[] = [];
  const attempts: Array<[string, Record<string, unknown>]> = [
    [SEND.name, { channel: "C-general", text: SECRET_KEY }], // the reviewer's repro: a plain allowed text argument
    [SEND.name, { channel: "C-general", text: `see <${SECRET_SESSION}> ok` }], // decorated
    [SEND.name, { channel: "C-general", text: SECRET_BEARER }], // the raw token behind a "Bearer ..." header
    [SEND.name, { channel: "C-general", text: `pin ${SECRET_SHORT}` }], // short secrets are not ignored
    [SEND.name, { channel: "C-general", text: Buffer.from(SECRET_KEY).toString("base64") }], // encoded
    [SEND.name, { channel: "C-general", text: encodeURIComponent(`Bearer ${SECRET_BEARER}`) }],
    ["slack.search", { terms: ["fine", `x${SECRET_KEY}x`] }], // nested in an array
  ];
  for (const [i, [tool, args]] of attempts.entries()) {
    try {
      await gateway.call(token, { tool, connectionId: work.id, callId: `leak-${i}`, arguments: args });
      assert.fail(`attempt ${i} was accepted`);
    } catch (error) {
      assert.ok(gwCode("invalid_input")(error), `attempt ${i}`);
      errors.push(String(error), JSON.stringify(error), (error as Error).stack ?? "");
    }
  }
  // Even with a replayed callId of a stored action, the refusal comes first.
  assert.equal((await gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "clean", arguments: sendArgs })).status, "succeeded");
  await assert.rejects(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "clean", arguments: { channel: "C-general", text: SECRET_KEY } }), gwCode("invalid_input"));
  assert.equal(store.listActions().length, 1);
  assert.equal(adapter.effects, 1);
  assert.ok(adapter.calls.every((c) => !JSON.stringify(c.arguments).includes(SECRET_KEY)));
  const actions = JSON.stringify(store.listActions());
  gateway.close();
  store.close();
  const bytes = hostBytes(dir);
  for (const secret of [SECRET_KEY, SECRET_SESSION, SECRET_BEARER, `pin ${SECRET_SHORT}`]) {
    assert.ok(!bytes.includes(secret), "secret reached host storage");
    assert.ok(!actions.includes(secret), "secret reached an action");
    assert.ok(!errors.join("\n").includes(secret), "secret echoed in an error");
  }
  assert.throws(() => new SyntheticCredentialBroker().put("empty", { headers: { a: "" }, allowedHosts: [HOST] }));
});

test("retire then re-register of the same manifest invalidates approvals pinned to the old revision", async (t) => {
  const { store, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "ask" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const approve = async (callId: string) => {
    const input = { tool: SEND.name, connectionId: work.id, callId, arguments: sendArgs };
    const action = await gateway.call(token, input);
    store.decideAction(action.actionId, { decision: "allow", requestHash: action.requestHash });
    assert.equal(store.getAction(action.actionId).state, "ready");
    return { input, action };
  };
  // Crash simulation: registry writes only, no withdrawal (the reviewer's repro, revision 1 -> 3, same hash).
  const crashed = await approve("crash");
  const before = gateway.registry.getTool(SEND.name)!;
  gateway.registry.retireTool(SEND.name);
  const after = gateway.registry.registerTool(SEND);
  assert.equal(after.manifestHash, before.manifestHash);
  assert.equal(after.revision, 3);
  assert.equal(store.getAction(crashed.action.actionId).state, "ready");
  const replay = await gateway.call(token, crashed.input);
  assert.equal(replay.status, "blocked");
  assert.equal(replay.reason, "permission_changed");
  assert.equal(adapter.calls.length, 0);

  // Through the gateway the pending approval is withdrawn as soon as the tool comes back.
  const live = await approve("live");
  gateway.retireTool(SEND.name);
  gateway.registerTool(SEND);
  assert.equal(store.getAction(live.action.actionId).state, "blocked");
  assert.equal((await gateway.call(token, live.input)).status, "blocked");
  // A fresh call pins the new revision and works once approved.
  const fresh = await approve("fresh");
  assert.equal((await gateway.call(token, fresh.input)).status, "succeeded");
  assert.equal(adapter.effects, 1);
});

test("destinations must be strings; URL destinations need canonical https on explicit origins", async (t) => {
  const { store, adapter, gateway, bot, work } = setup(t);
  const tool = (name: string, dest: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...SEND, name, upstreamSlug: name.toUpperCase().replace(/[.-]/g, "_"), destinationArgument: "target", ...extra,
    inputSchema: { type: "object", additionalProperties: false, required: ["target"], properties: { target: dest } },
  });
  // The reviewer's repro: an unbounded integer destination was accepted and 909090 dispatched.
  assert.throws(() => gateway.registerTool(tool("slack.num", { type: "integer" })), gwCode("invalid_input"));
  assert.throws(() => gateway.registerTool(tool("slack.num2", { type: "integer", minimum: 1, maximum: 9 })), gwCode("invalid_input"));
  assert.throws(() => gateway.registerTool(tool("slack.bool", { type: "boolean" })), gwCode("invalid_input"));
  // URL destinations: regex alone is never enough, origins are mandatory and must be bare https origins.
  const urlPattern = { type: "string", maxLength: 200, pattern: "^https://allowed\\.test/|/ok$" };
  assert.throws(() => gateway.registerTool(tool("slack.hook0", urlPattern)), gwCode("invalid_input"));
  const namedUrl = { type: "string", maxLength: 200, pattern: "^[a-z/:.]+$" };
  assert.throws(() => gateway.registerTool({ ...tool("slack.hook0", namedUrl), destinationArgument: "url",
    inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: namedUrl } } }), gwCode("invalid_input"), "network-named destination without origins");
  for (const origins of [["http://allowed.test"], ["https://allowed.test/path"], ["https://allowed.test:8443"], ["https://user@allowed.test"], []]) {
    assert.throws(() => gateway.registerTool(tool("slack.hook0", urlPattern, { destinationOrigins: origins })), gwCode("invalid_input"), JSON.stringify(origins));
  }
  assert.throws(() => gateway.registerTool(tool("slack.hook0", { type: "string", maxLength: 100, enum: ["https://evil.test/x"] }, { destinationOrigins: ["https://allowed.test"] })), gwCode("invalid_input"));
  // Anchors that do not balance cannot be smuggled through the ^(?:...)$ wrapping.
  assert.throws(() => gateway.registerTool(tool("slack.paren", { type: "string", maxLength: 50, pattern: "^C-ops)|(.*$" })), gwCode("invalid_input"));
  assert.throws(() => gateway.registerTool(tool("slack.esc", { type: "string", maxLength: 50, pattern: "^C-ops\\$" })), gwCode("invalid_input"));

  gateway.registerTool(tool("slack.hook", urlPattern, { destinationOrigins: ["https://allowed.test"] }));
  gateway.registerTool(tool("slack.label", { type: "string", maxLength: 50, pattern: "^C-ops|-x$" }));
  for (const name of ["slack.hook", "slack.label"]) store.setGrant({ botId: bot.id, tool: name, destination: work.id, policy: "allow" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const call = (name: string, target: string, callId: string) => gateway.call(token, { tool: name, connectionId: work.id, callId, arguments: { target } });
  const refusedUrls = [
    "https://evil.test/ok", // matched the unwrapped alternation before
    "/ok", "https://allowed.test@evil.test/", "https://allowed.test.evil.test/", "http://allowed.test/",
    "https://ALLOWED.test/", "https://allowed.test:443/", "https://allowed.test:8443/", "https:allowed.test/", "https://allowed.test\\@evil.test/",
  ];
  for (const [i, target] of refusedUrls.entries()) await assert.rejects(call("slack.hook", target, `u${i}`), gwCode("invalid_input"), target);
  for (const [i, target] of ["evil-x", "https://x.test/C-ops", "C-ops-x"].entries()) await assert.rejects(call("slack.label", target, `l${i}`), gwCode("invalid_input"), target);
  assert.equal(store.listActions().length, 0);
  assert.equal(adapter.calls.length, 0);
  assert.equal((await call("slack.hook", "https://allowed.test/", "ok1")).status, "succeeded");
  assert.equal((await call("slack.label", "C-ops", "ok2")).status, "succeeded");
  assert.equal((await call("slack.label", "-x", "ok3")).status, "succeeded");
  assert.deepEqual(adapter.calls.map((c) => [c.host, c.arguments.target]), [[HOST, "https://allowed.test/"], [HOST, "C-ops"], [HOST, "-x"]]);
});

function hostLocked(error: unknown): boolean {
  return error instanceof HostError && error.code === "host_locked";
}
function snapshot(gateway: CapabilityGateway, store: HostStore): string {
  return JSON.stringify([gateway.registry.listTools(), gateway.registry.listConnections(), store.listActions()]);
}

test("a host that lost its writer lease cannot change the gateway registry or its actions", async (t) => {
  const { dir, store, adapter, gateway, bot, work } = setup(t);
  store.setGrant({ botId: bot.id, tool: SEND.name, destination: work.id, policy: "ask" });
  const { token } = gateway.issueCapability({ turnId: runningTurn(store, bot.id).turn.id });
  const pending = await gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "lease", arguments: sendArgs });
  store.decideAction(pending.actionId, { decision: "allow", requestHash: pending.requestHash });
  const before = snapshot(gateway, store);
  const registryBytes = () => readdirSync(dir).filter((f) => f.startsWith("gateway.sqlite")).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
  const bytesBefore = registryBytes();

  const raw = new DatabaseSync(join(dir, "dexter.sqlite"));
  raw.exec("UPDATE host_lease SET token = 'stolen'");
  raw.close();
  assert.throws(() => store.createBot({ name: "x", profileId: "work", engine: "claude" }), hostLocked);

  const connectInput = { profileId: "work", toolkit: "slack", label: "Late", upstreamAccountRef: "ca_late", credentialRef: "cred-slack-work", allowedHosts: [HOST] };
  const mutations: Array<[string, () => unknown]> = [
    ["gateway.connectAccount", () => gateway.connectAccount(connectInput)],
    ["gateway.registerTool new", () => gateway.registerTool({ ...READ, name: "slack.new_tool", upstreamSlug: "SLACK_NEW_TOOL" })],
    ["gateway.registerTool repin", () => gateway.registerTool({ ...SEND, description: "re-pinned without the lease" })],
    ["gateway.registerTool identical", () => gateway.registerTool(SEND)],
    ["gateway.retireTool", () => gateway.retireTool(SEND.name)],
    ["gateway.revokeConnection", () => gateway.revokeConnection(work.id)],
    ["registry.connect", () => gateway.registry.connect(connectInput)],
    ["registry.registerTool", () => gateway.registry.registerTool({ ...SEND, description: "direct" })],
    ["registry.retireTool", () => gateway.registry.retireTool(READ.name)],
    ["registry.revokeConnection", () => gateway.registry.revokeConnection(work.id)],
    ["new GatewayRegistry", () => new GatewayRegistry(dir, store.hostId, store.ownerId, Date.now, (op) => store.withWriterLease(op))],
    ["new CapabilityGateway", () => new CapabilityGateway({ store, broker: new SyntheticCredentialBroker(), adapter })],
  ];
  for (const [label, mutate] of mutations) assert.throws(mutate, hostLocked, label);
  // The approved action is neither dispatched nor blocked by a host without authority.
  await assert.rejects(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "lease", arguments: sendArgs }), hostLocked);
  // A new call is reported as a lost lease, not as a missing grant, and persists nothing.
  await assert.rejects(gateway.call(token, { tool: SEND.name, connectionId: work.id, callId: "lease-new", arguments: sendArgs }), hostLocked);
  assert.equal(snapshot(gateway, store), before);
  assert.equal(registryBytes(), bytesBefore);
  assert.equal(store.getAction(pending.actionId).state, "ready");
  assert.equal(adapter.calls.length, 0);
});

test("a closed host blocks registry writes and startup; a fresh data dir gets no registry file without the lease", (t) => {
  const { store, gateway, work } = setup(t);
  const registry = gateway.registry;
  store.close();
  for (const mutate of [
    () => gateway.registerTool({ ...READ, description: "after close" }),
    () => gateway.retireTool(READ.name),
    () => registry.revokeConnection(work.id),
    () => registry.connect({ profileId: "work", toolkit: "slack", label: "x", upstreamAccountRef: "ca_x", credentialRef: "c", allowedHosts: [HOST] }),
  ]) assert.throws(mutate, hostLocked);

  const dir = mkdtempSync(join(tmpdir(), "dexter-gateway-fresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = new HostStore({ dataDir: dir });
  const raw = new DatabaseSync(join(dir, "dexter.sqlite"));
  raw.exec("UPDATE host_lease SET token = 'stolen'");
  raw.close();
  assert.throws(() => new CapabilityGateway({ store: fresh, broker: new SyntheticCredentialBroker(), adapter: new FakeAdapter() }), hostLocked);
  assert.equal(existsSync(join(dir, "gateway.sqlite")), false);
  fresh.close();
  assert.throws(() => new GatewayRegistry(dir, fresh.hostId, fresh.ownerId, Date.now, (op) => fresh.withWriterLease(op)), hostLocked);
  assert.equal(existsSync(join(dir, "gateway.sqlite")), false);
});
