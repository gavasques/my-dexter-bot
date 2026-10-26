import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { APPROVAL_POLICY_SCOPE_VERSION } from "@dexter/contracts";
import { BrowserUseClient, BrowserUseKeyVault, BrowserUseError, BROWSER_USE_API, type FetchLike } from "@dexter/connectors";
import { CapabilityGateway, GatewayError, SyntheticCredentialBroker } from "@dexter/gateway";
import { HostStore } from "@dexter/hub";
import { BrowserUseTurnSurface, BROWSER_USE_DESTINATION } from "../packages/cli/src/browser-use-surface.js";

// No network, provider account, auth file, persistent key store, personal browser or paid task is used.
const KEY = "synthetic-browser-key-solely-fixture";
const TASK = "11111111-1111-4111-8111-111111111111", SESSION = "22222222-2222-4222-8222-222222222222";
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
type Observed = { path: string; method: string; body: unknown; keyMatched: boolean; manualRedirect: boolean };
const args = { task: "Read the synthetic example page and summarize it.", start_url: "https://example.com/" };
const configure = (revision: number, enabled = true) => ({ expectedRevision: revision, enabled, allowed_domains: ["example.com"], max_steps: 7, timeout_seconds: 30, profile_id: "" });

function fixture(t: TestContext, route?: (entry: Observed, signal: AbortSignal | null | undefined) => Promise<Response> | Response, clock: () => number = Date.now) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dexter-browser-use-test-"))); chmodSync(dir, 0o700);
  const store = new HostStore({ dataDir: dir, clock }), gateway = new CapabilityGateway({ store, broker: new SyntheticCredentialBroker(), adapter: { execute: async () => null } });
  const bot = store.createBot({ name: "Browser specialist", profileId: "synthetic", engine: "codex" });
  const other = store.createBot({ name: "Private other bot", profileId: "synthetic-other", engine: "claude" });
  const observed: Observed[] = [];
  const fetch: FetchLike = async (url, init) => {
    assert.ok(url.startsWith(BROWSER_USE_API + "/"), "the only request origin is the fixed API");
    const entry: Observed = { path: url.slice(BROWSER_USE_API.length), method: init.method ?? "GET", body: init.body === undefined ? null : JSON.parse(init.body as string),
      keyMatched: new Headers(init.headers).get("X-Browser-Use-API-Key") === KEY, manualRedirect: init.redirect === "manual" };
    observed.push(entry);
    if (route) return route(entry, init.signal);
    if (entry.path === "/tasks" && entry.method === "POST") return response({ id: TASK, sessionId: SESSION }, 202);
    if (entry.path === `/tasks/${TASK}/status`) return response({ id: TASK, status: "finished", output: "Synthetic result", isSuccess: true });
    if (entry.path === `/tasks/${TASK}` && entry.method === "PATCH") return response({ id: TASK, status: "stopped" });
    if (entry.path === `/sessions/${SESSION}`) return response({ id: SESSION, status: "stopped", liveUrl: "https://never-return.example/", cdpUrl: "wss://never-return.example/" });
    throw new Error("Unexpected synthetic route.");
  };
  const vault = new BrowserUseKeyVault(); vault.set(KEY);
  const surface = new BrowserUseTurnSurface({ store, base: gateway, vault, client: new BrowserUseClient({ fetch, pollIntervalMs: 1, httpTimeoutMs: 1000 }) });
  const thread = store.createThread(bot.id), { turn } = store.createTurn(thread.id, { clientRequestId: "browser-use-fixture", content: "Synthetic browser request" });
  assert.equal(store.claimNextTurn(thread.id)?.id, turn.id);
  const token = surface.issueCapability({ turnId: turn.id }).token;
  const call = (name: string, id: string, input: unknown = {}) => surface.call(token, { connectionId: BROWSER_USE_DESTINATION, tool: "dexter.browseruse." + name, callId: id, arguments: input });
  const enable = () => { const config = store.getBrowserUseConfiguration(); store.patchBrowserUseSettings({ expectedHostID: store.hostId, expectedRevision: config.revision,
    enabled: true, bots: { [bot.id]: { enabled: true, allowedDomains: ["example.com"], maxSteps: 7, timeoutSeconds: 30, profileId: null } } }); surface.configurationChanged(); };
  const allow = async (id: string, input = args) => { const pending = await call("run", id, input); assert.equal(pending.status, "awaiting_approval");
    store.decideAction(pending.actionId, { requestHash: pending.requestHash, decision: "allow" }); return pending; };
  t.after(async () => { await surface.close(); await vault.lock(); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, bot, other, surface, vault, observed, call, enable, allow, token, thread };
}

test("Browser Use: own status and owner-approved configuration do not start browsers or expose other bots", async t => {
  const f = fixture(t);
  assert.ok(f.surface.listTools(f.token).some(tool => tool.name === "dexter.browseruse.run"));
  const status = await f.call("status", "status"); assert.ok(!JSON.stringify(status).includes(f.other.id)); assert.ok(!JSON.stringify(status).includes(KEY));
  assert.equal((status.result as Record<string, unknown>).runAvailable, false);
  await assert.rejects(f.call("run", "before-activation", args));
  assert.equal(f.store.listActions().length, 0); assert.equal(f.observed.length, 0);
  const proposed = await f.call("configure", "configure-denied", configure(0));
  f.store.decideAction(proposed.actionId, { requestHash: proposed.requestHash, decision: "deny" });
  assert.equal((await f.call("configure", "configure-denied", configure(0))).status, "denied"); assert.equal(f.store.getBrowserUseConfiguration().revision, 0);
  const accepted = await f.call("configure", "configure", configure(0)); f.store.decideAction(accepted.actionId, { requestHash: accepted.requestHash, decision: "allow" });
  const saved = await f.call("configure", "configure", configure(0)); assert.equal(saved.status, "succeeded");
  assert.equal(f.store.getBrowserUseConfiguration().bots[f.bot.id]?.enabled, true); assert.equal(f.store.getBrowserUseConfiguration().enabled, false);
  assert.equal(f.store.getGrant(f.bot.id, "dexter.browseruse.run", BROWSER_USE_DESTINATION)?.policy, "deny");
  assert.equal((await f.call("configure", "configure", configure(0))).actionId, saved.actionId); assert.equal(f.store.getBrowserUseConfiguration().revision, 1);
  assert.equal(f.observed.length, 0);
});

test("Browser Use: exact deny/allow and durable replay send one one-off task with the pinned policy", async t => {
  const f = fixture(t); f.enable();
  const denied = await f.call("run", "denied", args); f.store.decideAction(denied.actionId, { requestHash: denied.requestHash, decision: "deny" });
  assert.equal((await f.call("run", "denied", args)).status, "denied"); assert.equal(f.observed.length, 0);
  const pending = await f.allow("approved"), action = f.store.getAction(pending.actionId);
  assert.equal(action.request.botId, f.bot.id); assert.equal(action.request.threadId, f.thread.id);
  const done = await f.call("run", "approved", args); assert.equal(done.status, "succeeded");
  assert.deepEqual(done.result, { outcome: "finished", output: "Synthetic result", outputOmitted: false, providerReportedSuccess: true, independentlyVerified: false, sessionClosed: true });
  assert.equal((await f.call("run", "approved", args)).actionId, done.actionId);
  assert.equal(f.observed.filter(entry => entry.method === "POST").length, 1);
  const created = f.observed.find(entry => entry.method === "POST")!.body as Record<string, unknown>;
  assert.deepEqual(created.allowedDomains, ["example.com"]); assert.equal(created.maxSteps, 7); assert.equal(created.llm, "browser-use-2.0");
  assert.deepEqual(created.sessionSettings, { enableRecording: false }); assert.ok(!Object.hasOwn(created, "sessionId")); assert.ok(!Object.hasOwn(created, "secrets"));
  assert.ok(f.observed.every(entry => entry.keyMatched && entry.manualRedirect));
  const stored = JSON.stringify(f.store.listActions()); assert.ok(!stored.includes(KEY)); assert.ok(!stored.includes(TASK)); assert.ok(!stored.includes(SESSION));
  assert.ok(!readFileSync(join(f.dir, "dexter.sqlite")).includes(Buffer.from(KEY)));
});

test("Browser Use: foreign identity, arbitrary session, credential text, URL query and domain escapes are refused before persistence", async t => {
  const f = fixture(t); f.enable();
  const invalid = [{ ...args, botId: f.other.id }, { ...args, sessionId: SESSION }, { ...args, profileId: SESSION },
    { ...args, task: KEY }, { ...args, task: "api_key=super-secret-material" }, { ...args, start_url: "https://other.example/" },
    { ...args, start_url: "https://example.com/?access_token=synthetic-value" }, { ...args, start_url: "https://example.com.evil.test/" },
    { ...args, start_url: "http://example.com/" }, { ...args, start_url: "https://user:pass@example.com/" }];
  for (let index = 0; index < invalid.length; index++) await assert.rejects(f.call("run", "invalid-" + index, invalid[index]));
  assert.equal(f.store.listActions().length, 0); assert.equal(f.observed.length, 0);
  await assert.rejects(f.call("configure", "foreign-config", { ...configure(1), botId: f.other.id }));
});

test("Browser Use: lost POST receipt becomes unknown and replay never submits or lists provider tasks again", async t => {
  const f = fixture(t, entry => { if (entry.method === "POST") throw new Error("Synthetic lost delivery " + KEY); throw new Error("No other request should occur."); }); f.enable();
  await f.allow("uncertain"); const unknown = await f.call("run", "uncertain", args); assert.equal(unknown.status, "unknown"); assert.equal(unknown.reason, "executor_error");
  assert.equal((await f.call("run", "uncertain", args)).actionId, unknown.actionId); assert.equal(f.observed.length, 1);
  assert.equal(f.surface.status().cleanupPending, true); await f.vault.lock(); assert.equal(f.surface.status().cleanupPending, true);
  assert.ok(!JSON.stringify(unknown).includes(KEY)); assert.equal(f.surface.status().credential.unlocked, false);
});

test("Browser Use: policy revocation during polling aborts the task and confirms only its known session", async t => {
  let f: ReturnType<typeof fixture>;
  f = fixture(t, entry => {
    if (entry.method === "POST") return response({ id: TASK, sessionId: SESSION }, 202);
    if (entry.path.endsWith("/status")) { const config = f.store.getBrowserUseConfiguration(); f.store.patchBrowserUseSettings({ expectedHostID: f.store.hostId,
      expectedRevision: config.revision, enabled: false, bots: config.bots }); f.surface.configurationChanged(); return response({ id: TASK, status: "started" }); }
    if (entry.method === "PATCH") return response({ id: TASK, status: "stopped" });
    return response({ id: SESSION, status: "stopped" });
  }); f.enable(); await f.allow("revoke");
  assert.equal((await f.call("run", "revoke", args)).status, "unknown");
  assert.deepEqual(f.observed.map(entry => entry.path), ["/tasks", `/tasks/${TASK}/status`, `/tasks/${TASK}`, `/sessions/${SESSION}`]);
  assert.equal(f.surface.status().activeTasks, 0); assert.equal(f.surface.status().cleanupPending, false);
  assert.ok(f.surface.listTools(f.token).some(tool => tool.name === "dexter.browseruse.run"));
  assert.equal(((await f.call("status", "revoked-status")).result as Record<string, unknown>).runAvailable, false);
  const actions = f.store.listActions().length, requests = f.observed.length;
  await assert.rejects(f.call("run", "revoked-run", args));
  assert.equal(f.store.listActions().length, actions); assert.equal(f.observed.length, requests);
});

test("Browser Use: explicit key lock drains an in-flight create and stops a late known task before discarding custody", async t => {
  let f: ReturnType<typeof fixture>, locked: Promise<void> | undefined;
  f = fixture(t, entry => {
    if (entry.method === "POST") { locked = f.vault.lock(); return response({ id: TASK, sessionId: SESSION }, 202); }
    if (entry.method === "PATCH") return response({ id: TASK, status: "stopped" });
    return response({ id: SESSION, status: "stopped" });
  }); f.enable(); await f.allow("lock"); assert.equal((await f.call("run", "lock", args)).status, "unknown"); await locked;
  assert.equal(f.observed.filter(entry => entry.method === "PATCH").length, 1); assert.equal(f.surface.status().cleanupPending, false);
  assert.deepEqual(f.vault.status(), { unlocked: false, expiresAt: null }); assert.equal(f.surface.status().activeTasks, 0);
  f.vault.set(KEY); assert.equal(f.vault.status().unlocked, true);
});

test("Browser Use: output credentials and control URLs never enter receipts; unconfirmed cleanup remains unknown", async t => {
  let cleanupWorks = true;
  const f = fixture(t, entry => {
    if (entry.method === "POST") return response({ id: TASK, sessionId: SESSION }, 202);
    if (entry.path.endsWith("/status")) return response({ id: TASK, status: "finished", output: "Provider echoed " + KEY, isSuccess: true, liveUrl: "https://private.example/" });
    if (entry.method === "PATCH") return response({ id: TASK, status: "stopped" });
    return response({ id: SESSION, status: cleanupWorks ? "stopped" : "active" });
  }); f.enable(); await f.allow("secret-output"); const done = await f.call("run", "secret-output", args);
  assert.equal(done.status, "succeeded"); assert.equal((done.result as Record<string, unknown>).output, null); assert.equal((done.result as Record<string, unknown>).outputOmitted, true);
  assert.ok(!JSON.stringify(done).includes(KEY)); cleanupWorks = false;
  await f.allow("cleanup-unknown"); const unknown = await f.call("run", "cleanup-unknown", args); assert.equal(unknown.status, "unknown");
  assert.equal(f.surface.status().cleanupPending, true); assert.equal(f.observed.filter(entry => entry.method === "PATCH").length, 2, "one cleanup attempt for each known task");
});

test("Browser Use: expiring custody and configuration revision pins refuse stale approvals without POST", async t => {
  let now = 1000; const vault = new BrowserUseKeyVault({ ttlMs: 1000, now: () => now }); vault.set(KEY); const lease = vault.use();
  now = 2001; assert.equal(vault.status().unlocked, false); assert.throws(() => lease.assertCurrent(), error => error instanceof BrowserUseError && error.code === "locked"); await vault.lock();
  const f = fixture(t); f.enable(); await f.allow("stale-key"); await f.vault.lock(); f.vault.set(KEY);
  assert.equal((await f.call("run", "stale-key", args)).status, "blocked"); assert.equal(f.observed.length, 0);
  const policy = configure(f.store.getBrowserUseConfiguration().revision), pending = await f.call("configure", "stale-config", policy);
  f.store.decideAction(pending.actionId, { requestHash: pending.requestHash, decision: "allow" }); f.enable();
  assert.equal((await f.call("configure", "stale-config", policy)).status, "blocked"); assert.equal(f.observed.length, 0);
});

test("Browser Use: discoverable run never bypasses missing/denied/expired grants, key lock, policy, domain or capability TTL", async t => {
  let now = Date.now();
  const f = fixture(t, undefined, () => now), initial = f.surface.listTools(f.token).find(tool => tool.name === "dexter.browseruse.run")!;
  f.store.setBotApprovalPolicy(f.bot.id, { expectedHostId: f.store.hostId, expectedRevision: 0, clientRequestId: "synthetic-approve-all",
    mode: "approve_all", eligibleScopeVersion: APPROVAL_POLICY_SCOPE_VERSION });
  const blocked = async (id: string, input = args, available = false) => {
    const view = f.surface.listTools(f.token).find(tool => tool.name === "dexter.browseruse.run")!;
    assert.equal(view.name, initial.name); assert.equal(view.connectionId, initial.connectionId);
    assert.deepEqual(view.inputSchema, initial.inputSchema);
    assert.equal(((await f.call("status", id + "-status")).result as Record<string, unknown>).runAvailable, available);
    await assert.rejects(f.call("run", id, input), error => error instanceof GatewayError && error.code === "forbidden");
    assert.equal(f.store.listActions().length, 0); assert.equal(f.observed.length, 0);
  };
  await blocked("missing-grant");
  f.enable();
  f.store.setGrant({ botId: f.bot.id, tool: "dexter.browseruse.run", destination: BROWSER_USE_DESTINATION, policy: "deny" });
  await blocked("denied-grant");
  f.store.setGrant({ botId: f.bot.id, tool: "dexter.browseruse.run", destination: BROWSER_USE_DESTINATION, policy: "ask", expiresAt: f.store.now() - 1 });
  await blocked("expired-grant");
  f.enable(); await f.vault.lock(); await blocked("locked-key"); f.vault.set(KEY);
  let config = f.store.getBrowserUseConfiguration();
  f.store.patchBrowserUseSettings({ expectedHostID: f.store.hostId, expectedRevision: config.revision, enabled: false, bots: config.bots });
  f.surface.configurationChanged(); await blocked("globally-disabled");
  f.enable(); config = f.store.getBrowserUseConfiguration();
  f.store.patchBrowserUseBotPolicy(f.bot.id, { expectedHostID: f.store.hostId, expectedRevision: config.revision,
    policy: { ...config.bots[f.bot.id]!, enabled: false } });
  f.surface.configurationChanged(); await blocked("bot-disabled");
  f.enable(); await blocked("foreign-domain", { ...args, start_url: "https://foreign.example/" }, true);
  const turnId = f.store.listTurns(f.thread.id)[0]!.id, issued = f.surface.issueCapability({ turnId, ttlMs: 1 }), expired = issued.token;
  assert.equal(issued.scope.expiresAt, now + 1);
  assert.ok(f.surface.listTools(expired).some(tool => tool.name === "dexter.browseruse.run"), "issuance and discovery happen before the exact expiry");
  now = issued.scope.expiresAt;
  assert.throws(() => f.surface.listTools(expired), error => error instanceof GatewayError && error.code === "unauthorized");
  await assert.rejects(f.surface.call(expired, { connectionId: BROWSER_USE_DESTINATION, tool: "dexter.browseruse.run", callId: "expired-capability", arguments: args }),
    error => error instanceof GatewayError && error.code === "unauthorized");
  assert.equal(f.store.listActions().length, 0); assert.equal(f.observed.length, 0);
});
