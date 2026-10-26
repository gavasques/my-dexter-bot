import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, type AdapterCall, type CredentialBroker, type ToolManifest } from "@dexter/gateway";
import { ManagedAppsRuntime, type ManagedAppsRuntimeOptions } from "../packages/connectors/src/managed-apps-runtime.js";
import type { ManagedAppsProvider, ManagedProvisionRequest, ManagedAccountReceipt } from "../packages/connectors/src/managed-apps.js";
import type { FetchLike } from "../packages/connectors/src/http.js";
const HOST = "backend.composio.dev", REF = "cred-managed", SECRET = "synthetic-managed-runtime-key-17", VERSION = "20260901_00";
const TOOL: ToolManifest = { name: "slack.read", toolkit: "slack", upstreamSlug: "SLACK_READ_MESSAGES", version: VERSION, description: "Synthetic read", upstreamHost: HOST, effect: "read", destinationArgument: "channel", destinationOrigins: null, inputSchema: { type: "object", additionalProperties: false, required: ["channel"], properties: { channel: { type: "string", maxLength: 30, enum: ["C-approved"] } } } };
const fails = (code: string) => (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code;
const held = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function setup(t: TestContext, owned = false) {
    const dir = mkdtempSync(join(tmpdir(), "dexter-managed-runtime-")), store = new HostStore({ dataDir: dir });
    const bot = store.createBot({ name: "Synthetic", profileId: "work", engine: "claude" });
    let acquireCalls = 0, disposeCalls = 0, providerCalls = 0;
    let provisionHook: ((req: ManagedProvisionRequest, signal: AbortSignal) => Promise<ManagedAccountReceipt>) | null = null;
    let fetchHook: FetchLike | null = null;
    let disposeHook: (() => void | Promise<void>) | null = null;
    const sent: Array<{
        url: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
    }> = [];
    const broker: CredentialBroker = { acquire: (ref, host) => { acquireCalls++; return ref === REF && host === HOST ? { headers: { "x-api-key": SECRET } } : null; }, secretValues: () => [SECRET] };
    const receipt = (req: ManagedProvisionRequest): ManagedAccountReceipt => ({ installationId: req.installationId, ownerId: req.ownerId, profileId: req.profileId, toolkit: req.toolkit, userId: req.userId, accountId: "ca_runtime", version: req.version, status: "active" });
    const provider: ManagedAppsProvider = { catalog: async () => [TOOL], provision: async (req, signal) => { providerCalls++; return provisionHook ? provisionHook(req, signal) : receipt(req); }, lookup: async () => null, account: async (r) => r };
    const fetch: FetchLike = async (url, init) => { sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Record<string, unknown> }); return fetchHook ? fetchHook(url, init) : new Response(JSON.stringify({ data: { synthetic: true, value: SECRET }, error: null, successful: true }), { headers: { "content-type": "application/json" } }); };
    const options: ManagedAppsRuntimeOptions = { identity: { installationId: store.hostId, ownerId: store.ownerId }, provider, broker, credentialRef: REF, fetch, ...(owned ? { disposeOwnedBroker: async () => { disposeCalls++; await disposeHook?.(); } } : {}) };
    const runtime = new ManagedAppsRuntime(options), gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter });
    t.after(async () => { await runtime.close().catch(() => undefined); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
    const cap = () => { const thread = store.createThread(bot.id), turn = store.createTurn(thread.id, { clientRequestId: "synthetic", content: "synthetic" }).turn; store.claimNextTurn(thread.id); return gateway.issueCapability({ turnId: turn.id }); };
    const input = { profileId: "work", toolkit: "slack", version: VERSION, label: "Work" };
    const ready = async () => { runtime.bind(store, gateway); const rev = await runtime.admin.syncCatalog(0); runtime.admin.approveTools(rev, [TOOL.name]); return runtime.admin.provision("op1", input); };
    return { dir, store, bot, options, provider, broker, runtime, gateway, sent, input, receipt, ready, cap, counts: () => ({ acquireCalls, disposeCalls, providerCalls }), onProvision: (fn: NonNullable<typeof provisionHook>) => { provisionHook = fn; }, onFetch: (fn: FetchLike) => { fetchHook = fn; }, onDispose: (fn: () => void | Promise<void>) => { disposeHook = fn; } };
}
function call(s: ReturnType<typeof setup>, scope: AdapterCall["scope"], connectionId = "conn_missing"): AdapterCall { return { toolkit: "slack", upstreamSlug: TOOL.upstreamSlug, version: VERSION, host: HOST, upstreamUserId: `dx:${s.store.hostId}:${s.store.ownerId}:work`, upstreamAccountRef: "ca_runtime", arguments: { channel: "C-approved" }, idempotencyKey: "synthetic", connectionId, scope }; }
test("unbound cycle denies admin, credential release and adapter without touching provider/network/database", async (t) => {
    const s = setup(t), { scope } = s.cap();
    assert.throws(() => s.runtime.admin, fails("unbound"));
    assert.equal(s.runtime.broker.acquire(REF, HOST), null);
    await assert.rejects(s.runtime.adapter.execute(call(s, scope), { headers: { "x-api-key": SECRET } }, { signal: new AbortController().signal }), fails("unbound"));
    assert.equal(s.sent.length, 0);
    assert.equal(s.counts().acquireCalls, 0);
    assert.equal(existsSync(join(s.dir, "managed-apps.sqlite")), false);
    assert.ok(Object.isFrozen(s.runtime) && Object.isFrozen(s.runtime.adapter) && Object.isFrozen(s.runtime.broker));
});
test("one bind validates actual identities and path before service DB, then rejects late rebind", async (t) => {
    const s = setup(t), otherDir = mkdtempSync(join(tmpdir(), "dexter-runtime-other-")), other = new HostStore({ dataDir: otherDir });
    try {
        assert.throws(() => s.runtime.bind(other, s.gateway), fails("identity_mismatch"));
        assert.equal(existsSync(join(otherDir, "managed-apps.sqlite")), false);
        assert.equal(existsSync(join(s.dir, "managed-apps.sqlite")), false);
    }
    finally {
        other.close();
        rmSync(otherDir, { recursive: true, force: true });
    }
    s.runtime.bind(s.store, s.gateway);
    assert.throws(() => s.runtime.bind(s.store, s.gateway), fails("already_bound"));
    await s.runtime.close();
    assert.throws(() => s.runtime.bind(s.store, s.gateway), fails("closed"));
});
test("trusted options reject invalid origins/header policy/identities/callbacks before DB", async (t) => {
    const s = setup(t);
    for (const change of [{ origin: "http://backend.composio.dev" }, { origin: "https://backend.composio.dev/path" }, { origin: "https://backend.composio.dev:123" }, { authHeaders: ["authorization"] }, { authHeaders: ["x-api-key", "x-api-key"] }, { identity: { installationId: s.store.hostId, ownerId: "*" } }, { credentialRef: "*" }, { disposeOwnedBroker: 42 }, { limits: { timeoutMs: 0 } }, { limits: { unexpected: true } }])
        assert.throws(() => new ManagedAppsRuntime({ ...s.options, ...change } as ManagedAppsRuntimeOptions), fails("invalid_options"));
    assert.equal(existsSync(join(s.dir, "managed-apps.sqlite")), false);
    assert.equal(s.counts().acquireCalls, 0);
});
test("metadata snapshots cannot be changed after construction and broker has exact ref/host allowlist", async (t) => {
    const s = setup(t);
    const identity = { ...s.options.identity }, headers = ["x-api-key"];
    const runtime = new ManagedAppsRuntime({ ...s.options, identity, authHeaders: headers });
    identity.ownerId = "other";
    headers.push("x-user-api-key");
    runtime.bind(s.store, s.gateway);
    assert.equal(runtime.broker.acquire("wrong", HOST), null);
    assert.equal(runtime.broker.acquire(REF, "evil.example"), null);
    assert.equal(runtime.broker.acquire(REF, HOST)?.headers["x-api-key"], SECRET);
    assert.equal(s.counts().acquireCalls, 1);
    await runtime.close();
});
test("owner admin -> catalog/account/grant -> actual versioned adapter preserves fixed user/account/headers and engine scrub", async (t) => {
    const s = setup(t), op = await s.ready(), { token } = s.cap();
    assert.deepEqual(s.gateway.listTools(token), []);
    await assert.rejects(s.gateway.call(token, { tool: TOOL.name, connectionId: op.connectionId, callId: "first", arguments: { channel: "C-approved" } }), fails("forbidden"));
    assert.equal(s.sent.length, 0);
    s.runtime.admin.grant({ operationId: "op1", botId: s.bot.id, tool: TOOL.name, policy: "allow" });
    const result = await s.gateway.call(token, { tool: TOOL.name, connectionId: op.connectionId, callId: "first", arguments: { channel: "C-approved" } });
    assert.equal(result.status, "succeeded");
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]!.url, "https://backend.composio.dev/api/v3.1/tools/execute/SLACK_READ_MESSAGES");
    assert.equal(s.sent[0]!.headers["x-api-key"], SECRET);
    assert.deepEqual(s.sent[0]!.body, { arguments: { channel: "C-approved" }, version: VERSION, user_id: `dx:${s.store.hostId}:${s.store.ownerId}:work`, connected_account_id: "ca_runtime" });
    await s.gateway.call(token, { tool: TOOL.name, connectionId: op.connectionId, callId: "first", arguments: { channel: "C-approved" } });
    assert.equal(s.sent.length, 1);
    for (const shown of [inspect(s.runtime, { showHidden: true, depth: 9 }), JSON.stringify(s.runtime), inspect(s.runtime.admin, { showHidden: true, depth: 9 }), JSON.stringify(s.runtime.admin.catalog()), JSON.stringify(s.runtime.admin.operation("op1")), readFileSync(s.store.databasePath).toString(), readFileSync(join(s.dir, "managed-apps.sqlite")).toString()])
        assert.ok(!shown.includes(SECRET) && !shown.includes(REF));
    s.runtime.admin.revoke("op1");
    assert.deepEqual(s.gateway.listTools(token), []);
    await assert.rejects(s.gateway.call(token, { tool: TOOL.name, connectionId: op.connectionId, callId: "next", arguments: { channel: "C-approved" } }), fails("forbidden"));
    assert.equal(s.sent.length, 1);
});
test("foreign account/user/host tampering is denied by actual adapter source", async (t) => {
    const s = setup(t), op = await s.ready(), { scope } = s.cap();
    const auth = { headers: { "x-api-key": SECRET } }, ctx = { signal: new AbortController().signal };
    for (const change of [{ upstreamAccountRef: "ca_foreign" }, { upstreamUserId: "foreign" }, { host: "evil.example" }, { version: "latest" }, { scope: { ...scope, ownerId: "foreign" } }])
        await assert.rejects(s.runtime.adapter.execute({ ...call(s, scope, op.connectionId!), ...change }, auth, ctx));
    assert.equal(s.sent.length, 0);
});
test("closing rejects retained admin port, credential acquisition, bind and adapter execution", async (t) => {
    const s = setup(t), op = await s.ready(), admin = s.runtime.admin, { scope } = s.cap();
    await s.runtime.close();
    assert.throws(() => s.runtime.admin, fails("closed"));
    assert.throws(() => admin.catalog(), fails("closed"));
    assert.throws(() => admin.grant({ operationId: "op1", botId: s.bot.id, tool: TOOL.name, policy: "allow" }), fails("closed"));
    assert.equal(s.runtime.broker.acquire(REF, HOST), null);
    await assert.rejects(s.runtime.adapter.execute(call(s, scope, op.connectionId!), { headers: { "x-api-key": SECRET } }, { signal: new AbortController().signal }), fails("closed"));
    assert.equal(s.sent.length, 0);
    assert.equal(s.counts().disposeCalls, 0);
});
test("held provider keeps close pending; owned broker disposal runs once only after service drain", async (t) => {
    const s = setup(t, true);
    s.runtime.bind(s.store, s.gateway);
    await s.runtime.admin.syncCatalog(0);
    s.runtime.admin.approveTools(1, [TOOL.name]);
    const pending = held<ManagedAccountReceipt>();
    let enter!: () => void, req!: ManagedProvisionRequest;
    const began = new Promise<void>(r => { enter = r; });
    s.onProvision(async (r) => { req = r; enter(); return pending.promise; });
    const provision = s.runtime.admin.provision("op1", s.input);
    await began;
    let closed = false;
    const close = s.runtime.close();
    assert.equal(s.runtime.close(), close);
    void close.then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(closed, false);
    assert.equal(s.counts().disposeCalls, 0);
    pending.resolve(s.receipt(req));
    await assert.rejects(provision);
    await close;
    assert.equal(s.counts().disposeCalls, 1);
    await s.runtime.close();
    assert.equal(s.counts().disposeCalls, 1);
});
test("held adapter request must settle before owned broker disposal", async (t) => {
    const s = setup(t, true), op = await s.ready(), { scope } = s.cap(), pending = held<Response>();
    let enter!: () => void;
    const began = new Promise<void>(r => { enter = r; });
    s.onFetch(async () => { enter(); return pending.promise; });
    const execution = s.runtime.adapter.execute(call(s, scope, op.connectionId!), { headers: { "x-api-key": SECRET } }, { signal: new AbortController().signal });
    await began;
    let disposed = false;
    s.onDispose(() => { disposed = true; });
    const close = s.runtime.close();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(disposed, false);
    pending.resolve(new Response(JSON.stringify({ data: { ok: true }, error: null, successful: true }), { headers: { "content-type": "application/json" } }));
    await execution.catch(() => undefined);
    await close;
    assert.equal(disposed, true);
    assert.equal(s.counts().disposeCalls, 1);
});
test("service writer failure quarantines cached close and prevents broker disposal", async (t) => {
    const s = setup(t, true);
    await s.ready();
    const db = new DatabaseSync(s.store.databasePath);
    const token = db.prepare("SELECT token FROM host_lease WHERE id=1").get()!.token as string;
    db.exec("UPDATE host_lease SET token='synthetic-lost' WHERE id=1");
    const close = s.runtime.close();
    assert.equal(s.runtime.close(), close);
    await assert.rejects(close, fails("drain_failed"));
    assert.equal(s.counts().disposeCalls, 0);
    assert.throws(() => s.runtime.admin, fails("closed"));
    db.prepare("UPDATE host_lease SET token=? WHERE id=1").run(token);
    db.close();
    await assert.rejects(s.runtime.close(), fails("drain_failed"));
    assert.equal(s.counts().disposeCalls, 0);
});
test("owned broker disposal failure is fixed, cached and never reports positive close", async (t) => {
    const s = setup(t, true);
    await s.ready();
    s.onDispose(() => { throw Error(SECRET); });
    const close = s.runtime.close();
    await assert.rejects(close, e => fails("dispose_failed")(e) && !inspect(e).includes(SECRET));
    assert.equal(s.runtime.close(), close);
    assert.equal(s.counts().disposeCalls, 1);
});
