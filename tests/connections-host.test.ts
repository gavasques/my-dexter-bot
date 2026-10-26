import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HostError } from "@dexter/hub";
import { createAuthorizedHostRouter, createHostApp } from "@dexter/hub/http";
import { unconfiguredConnectionsAdmin } from "@dexter/connectors";
import { connectionsHttpPort } from "../packages/cli/src/connections-services.js";
import { ACCESS_TOKEN, CATALOG, COMPOSIO_KEY, LINK_ORIGIN, READ, REFRESH_TOKEN, SEND, VERSION, hostLab, listen, serviceLab, type HostLab } from "./fixtures/connections-lab.js";

// End to end over real loopback HTTP: Apple-app contract → host routes → trusted service → fake Composio v3.1. Synthetic only.
async function connect(host: HostLab, id: string, extra: Record<string, unknown> = {}) {
  const catalog = (await host.api("GET", "/v1/connections/catalog")).json;
  const started = await host.api("POST", "/v1/connections/authorizations", { expectedHostID: host.store.hostId, clientRequestId: id, serviceId: "gmail",
    catalogPin: catalog.pin, profileId: null, label: null, replacesAccountId: null, ...extra });
  return { catalog, started };
}
function botIn(host: HostLab, name = "Assistente", profileId = "default") { return host.store.createBot({ name, profileId, engine: "claude" }); }

test("connect → confirmed account grants nothing; replay/conflict/stale pin; link only in memory", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc), bot = botIn(host);
  const status = await host.api("GET", "/v1/connections/status");
  assert.equal(status.status, 200); assert.equal(status.json.platform, "available"); assert.deepEqual(status.json.managedProviders, ["composio"]);
  const { catalog, started } = await connect(host, "req-1");
  assert.equal(catalog.platform, "available"); assert.equal(catalog.freshness, "fresh"); assert.equal(catalog.services[0].verification, "unproven");
  assert.deepEqual(catalog.services[0].tools.map((tool: { name: string }) => tool.name), [READ.name, SEND.name]);
  assert.equal(started.status, 201);
  assert.equal(started.json.state, "awaiting_user"); assert.equal(started.json.linkAvailable, true);
  assert.ok(started.json.authorizationURL.startsWith(`${LINK_ORIGIN}/link/`));
  const replay = await connect(host, "req-1");
  assert.equal(replay.started.status, 200); assert.equal(replay.started.json.id, started.json.id);
  assert.equal(svc.composio.count("POST", "/api/v3.1/connected_accounts/link"), 1);
  assert.equal((await connect(host, "req-1", { label: "Outro" })).started.status, 409);
  assert.equal((await connect(host, "req-2", { catalogPin: "f".repeat(64) })).started.status, 409);
  assert.equal(svc.composio.count("POST", "/api/v3.1/connected_accounts/link"), 1);
  // The owner finishes the hosted page; the host confirms only through a provider read.
  const returned = await host.api("POST", "/v1/connections/authorizations/req-1/callback", { expectedHostID: host.store.hostId, outcome: "returned", providerAccountRef: null });
  assert.equal(returned.json.state, "verifying");
  const ref = [...svc.composio.accounts.keys()][0]!;
  svc.composio.complete(ref, "Ana Sintética");
  const done = await host.api("GET", "/v1/connections/authorizations/req-1");
  assert.equal(done.json.state, "connected"); assert.equal(done.json.authorizationURL, null);
  const account = (await host.api("GET", `/v1/connections/accounts/${done.json.accountId}`)).json;
  assert.equal(account.status, "connected");
  // No email from the official identity endpoint for this synthetic account: honest label level, never "verified".
  assert.deepEqual({ ...account.identity, checkedAt: typeof account.identity.checkedAt }, { confirmation: "provider_display_name", value: "Ana Sintética",
    kind: "display_name", source: "provider_label", issuer: null, checkedAt: "number" });
  assert.equal(account.persistence, "managed_service"); assert.deepEqual(account.route, { kind: "managed", provider: "composio" });
  assert.deepEqual(account.bots, [{ botId: bot.id, access: "disabled", toolNames: [] }]);
  assert.deepEqual(host.gateway.listTools(host.cap(bot.id).token), [], "connecting grants nothing");
  const connection = host.gateway.registry.listConnections("default")[0]!;
  assert.equal(connection.upstreamAccountRef, ref); assert.deepEqual(connection.allowedHosts, ["connections.dexter.test"]);
  for (const file of readdirSync(host.dir).filter(name => name.includes(".sqlite"))) {
    const bytes = readFileSync(join(host.dir, file));
    for (const secret of [host.capability, COMPOSIO_KEY, ACCESS_TOKEN, REFRESH_TOKEN, "/link/lk_"]) assert.ok(!bytes.includes(secret), `${file} holds no credential or link`);
  }
});

test("cancelled and wrong-account callbacks never create an account; unknown provider outcome is read, not re-posted", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc); botIn(host);
  await connect(host, "cancel-1");
  const cancelled = await host.api("POST", "/v1/connections/authorizations/cancel-1/callback", { expectedHostID: host.store.hostId, outcome: "cancelled", providerAccountRef: null });
  assert.equal(cancelled.json.state, "cancelled"); assert.equal(cancelled.json.reason, "user_cancelled");
  await connect(host, "wrong-1");
  const wrong = await host.api("POST", "/v1/connections/authorizations/wrong-1/callback", { expectedHostID: host.store.hostId, outcome: "returned", providerAccountRef: "ca_someone_else" });
  assert.equal(wrong.json.state, "mismatch"); assert.equal(wrong.json.reason, "account_mismatch");
  for (const ref of svc.composio.accounts.keys()) svc.composio.complete(ref);
  assert.equal((await host.api("GET", "/v1/connections/authorizations/wrong-1")).json.state, "mismatch");
  assert.equal((await host.api("GET", "/v1/connections/accounts")).json.items.length, 0);
  // Provider ACK lost behind the service: 503 to the app, one link upstream, recovered by GET once the owner completes.
  svc.composio.faults.link = "drop";
  const lost = await connect(host, "lost-1");
  assert.equal(lost.started.status, 503); assert.equal(lost.started.json.error, "outcome_unknown");
  const before = svc.composio.count("POST", "/api/v3.1/connected_accounts/link");
  const pending = await host.api("GET", "/v1/connections/authorizations/lost-1");
  assert.equal(pending.json.state, "awaiting_user"); assert.equal(pending.json.reason, "link_not_recoverable"); assert.equal(pending.json.linkAvailable, false);
  const lostRef = [...svc.composio.accounts.values()].find(a => a.status === "INITIATED")!.id;
  svc.composio.complete(lostRef);
  assert.equal((await host.api("GET", "/v1/connections/authorizations/lost-1")).json.state, "connected");
  assert.equal(svc.composio.count("POST", "/api/v3.1/connected_accounts/link"), before, "no second link");
  // ACK lost between host and service: the service committed, the host keeps unknown and reconciles with a read.
  host.hostFetchFault.dropNextResponse = true;
  const hostLost = await connect(host, "lost-2");
  assert.equal(hostLost.started.status, 503);
  const recovered = await host.api("GET", "/v1/connections/authorizations/lost-2");
  assert.equal(recovered.json.state, "awaiting_user"); assert.equal(recovered.json.linkAvailable, false);
  assert.equal(svc.composio.count("POST", "/api/v3.1/connected_accounts/link"), before + 1);
});

test("bot access: owner CAS + receipts + hub grants; pinned execution through gateway approval and the trusted service", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc), bot = botIn(host), other = botIn(host, "Outro perfil", "work");
  // Two profiles: the owner must name one explicitly; nothing is guessed.
  assert.equal((await connect(host, "a0")).started.status, 400);
  await connect(host, "a1", { profileId: "default" });
  svc.composio.complete([...svc.composio.accounts.keys()][0]!);
  const accountId = (await host.api("GET", "/v1/connections/authorizations/a1")).json.accountId as string;
  const account = (await host.api("GET", `/v1/connections/accounts/${accountId}`)).json;
  const patch = (body: Record<string, unknown>) => host.api("PATCH", `/v1/connections/accounts/${accountId}/access`, { expectedHostID: host.store.hostId, expectedRevision: account.revision, ...body });
  assert.equal((await patch({ clientRequestId: "p-other", botId: other.id, enabled: true })).status, 403, "a bot of another profile is refused");
  assert.equal((await patch({ clientRequestId: "p-ghost", botId: "bot_ghost", enabled: true })).status, 404);
  const receipt = await patch({ clientRequestId: "p1", botId: bot.id, enabled: true });
  assert.equal(receipt.status, 200);
  assert.deepEqual({ ...receipt.json, createdAt: 0, requestHash: "" }, { version: 1, hostId: host.store.hostId, clientRequestId: "p1", kind: "access", accountId,
    requestHash: "", previousRevision: account.revision, revision: account.revision + 1, access: { botId: bot.id, enabled: true, tools: 2 }, disconnect: null, label: null, createdAt: 0 });
  assert.deepEqual((await patch({ clientRequestId: "p1", botId: bot.id, enabled: true })).json, receipt.json, "replay returns the original receipt");
  assert.equal((await patch({ clientRequestId: "p2", botId: bot.id, enabled: false })).status, 409, "stale revision");
  assert.deepEqual((await host.api("GET", "/v1/connections/receipts/p1")).json, receipt.json);
  assert.equal((await host.api("GET", "/v1/connections/receipts/never")).status, 404);
  const connectionId = host.gateway.registry.listConnections("default")[0]!.id;
  for (const tool of [READ, SEND]) assert.equal(host.store.getGrant(bot.id, tool.name, connectionId)?.policy, "ask");
  assert.deepEqual((await host.api("GET", `/v1/connections/accounts/${accountId}`)).json.bots.find((b: { botId: string }) => b.botId === bot.id), { botId: bot.id, access: "enabled", toolNames: [READ.name, SEND.name].sort() });
  const { token } = host.cap(bot.id);
  const tools = host.gateway.listTools(token);
  assert.deepEqual(tools.map(tool => [tool.name, tool.requiresApproval]), [[READ.name, true], [SEND.name, true]]);
  const request = { tool: READ.name, connectionId, callId: "call-1", arguments: { query: "in:inbox" } };
  const pending = await host.gateway.call(token, request);
  assert.equal(pending.status, "awaiting_approval");
  assert.equal(svc.composio.requests.filter(r => r.path.startsWith("/api/v3.1/tools/execute/") && !r.path.endsWith("/proxy")).length, 0, "nothing executes before the owner approves");
  const action = host.store.getAction(pending.actionId);
  host.store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
  const result = await host.gateway.call(token, request);
  assert.equal(result.status, "succeeded");
  const upstream = svc.composio.requests.filter(r => r.path.startsWith("/api/v3.1/tools/execute/") && !r.path.endsWith("/proxy"));
  assert.equal(upstream.length, 1);
  assert.deepEqual(upstream[0]!.body, { arguments: { query: "in:inbox" }, version: VERSION, user_id: `dx:${host.store.hostId}:${host.store.ownerId}:default`,
    connected_account_id: host.gateway.registry.getConnection(connectionId)!.upstreamAccountRef });
  assert.ok(!JSON.stringify(result).includes(host.capability));
  await host.gateway.call(token, request);
  assert.equal(svc.composio.requests.filter(r => r.path.startsWith("/api/v3.1/tools/execute/") && !r.path.endsWith("/proxy")).length, 1, "replay never re-executes");
  const current = (await host.api("GET", `/v1/connections/accounts/${accountId}`)).json;
  const off = await host.api("PATCH", `/v1/connections/accounts/${accountId}/access`, { expectedHostID: host.store.hostId, expectedRevision: current.revision, clientRequestId: "p3", botId: bot.id, enabled: false });
  assert.equal(off.json.access.enabled, false);
  assert.deepEqual(host.gateway.listTools(host.cap(bot.id).token), []);
});

test("disconnect: local revocation first, one provider delete, unknown settled by a read; upstream revocation closes locally", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc), bot = botIn(host);
  const ids: string[] = [];
  for (const id of ["c1", "c2", "c3"]) {
    await connect(host, id);
    svc.composio.complete([...svc.composio.accounts.values()].find(a => a.status === "INITIATED")!.id);
    ids.push((await host.api("GET", `/v1/connections/authorizations/${id}`)).json.accountId);
  }
  const first = (await host.api("GET", `/v1/connections/accounts/${ids[0]}`)).json;
  await host.api("PATCH", `/v1/connections/accounts/${ids[0]}/access`, { expectedHostID: host.store.hostId, expectedRevision: first.revision, clientRequestId: "g1", botId: bot.id, enabled: true });
  const connectionId = host.gateway.registry.listConnections("default")[0]!.id;
  assert.equal(host.gateway.listTools(host.cap(bot.id).token).length, 2);
  const revision = (await host.api("GET", `/v1/connections/accounts/${ids[0]}`)).json.revision;
  const receipt = await host.api("POST", `/v1/connections/accounts/${ids[0]}/disconnect`, { expectedHostID: host.store.hostId, clientRequestId: "d1", expectedRevision: revision });
  assert.equal(receipt.status, 200);
  assert.deepEqual(receipt.json.disconnect, { upstream: "deleted", revocation: "requested" });
  assert.deepEqual(host.gateway.listTools(host.cap(bot.id).token), [], "the revoked connection stops immediately");
  assert.equal(host.gateway.registry.getConnection(connectionId)!.status, "revoked");
  assert.deepEqual((await host.api("POST", `/v1/connections/accounts/${ids[0]}/disconnect`, { expectedHostID: host.store.hostId, clientRequestId: "d1", expectedRevision: revision })).json, receipt.json);
  assert.equal(svc.composio.count("DELETE", "/api/v3.1/connected_accounts/"), 1);
  assert.equal((await host.api("GET", `/v1/connections/accounts/${ids[0]}`)).json.status, "disconnected");
  // Unknown delete: the receipt records it; a read of the account settles it later without another delete.
  svc.composio.faults.delete = "drop";
  const second = (await host.api("GET", `/v1/connections/accounts/${ids[1]}`)).json;
  const unknown = await host.api("POST", `/v1/connections/accounts/${ids[1]}/disconnect`, { expectedHostID: host.store.hostId, clientRequestId: "d2", expectedRevision: second.revision });
  assert.equal(unknown.status, 503); assert.equal(unknown.json.error, "outcome_unknown");
  assert.equal((await host.api("GET", "/v1/connections/receipts/d2")).status, 404, "no receipt while the upstream result is unknown");
  const local = host.store.hostId && (await host.api("GET", "/v1/connections/accounts")).json.items.find((a: { id: string }) => a.id === ids[1]);
  assert.equal(local.status, "disconnecting"); assert.deepEqual(local.disconnect, { upstream: "unknown", revocation: "unknown" });
  const settled = (await host.api("GET", `/v1/connections/accounts/${ids[1]}`)).json;
  assert.equal(settled.status, "disconnected"); assert.deepEqual(settled.disconnect, { upstream: "deleted", revocation: "requested" });
  const late = (await host.api("GET", "/v1/connections/receipts/d2")).json;
  assert.equal(late.previousRevision, second.revision); assert.equal(late.revision, second.revision + 1); assert.equal(late.disconnect.upstream, "deleted");
  assert.deepEqual((await host.api("POST", `/v1/connections/accounts/${ids[1]}/disconnect`, { expectedHostID: host.store.hostId, clientRequestId: "d2", expectedRevision: second.revision })).json, late);
  assert.equal(svc.composio.count("DELETE", "/api/v3.1/connected_accounts/"), 2, "settled by reading, never a second delete");
  // Revoked at the provider (outside Dexter): the next read closes the local connection, never the reverse.
  const third = (await host.api("GET", `/v1/connections/accounts/${ids[2]}`)).json;
  svc.composio.set([...svc.composio.accounts.keys()].at(-1)!, "REVOKED");
  const closed = (await host.api("GET", `/v1/connections/accounts/${ids[2]}`)).json;
  assert.equal(closed.status, "disconnected"); assert.ok(closed.revision > third.revision);
  assert.equal(host.gateway.registry.listConnections("default").filter(c => c.status === "active").length, 0);
});

test("expired provider account needs reconnect; reconnect creates a new account and never transfers bot access", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc), bot = botIn(host);
  await connect(host, "r1");
  const oldRef = [...svc.composio.accounts.keys()][0]!;
  svc.composio.complete(oldRef, "Ana");
  const oldId = (await host.api("GET", "/v1/connections/authorizations/r1")).json.accountId;
  const old = (await host.api("GET", `/v1/connections/accounts/${oldId}`)).json;
  await host.api("PATCH", `/v1/connections/accounts/${oldId}/access`, { expectedHostID: host.store.hostId, expectedRevision: old.revision, clientRequestId: "g-old", botId: bot.id, enabled: true });
  svc.composio.set(oldRef, "EXPIRED");
  assert.equal((await host.api("GET", `/v1/connections/accounts/${oldId}`)).json.status, "needs_reconnect");
  await connect(host, "r2", { replacesAccountId: oldId });
  const newRef = [...svc.composio.accounts.keys()].find(ref => ref !== oldRef)!;
  svc.composio.complete(newRef, "Bruno");
  const newId = (await host.api("GET", "/v1/connections/authorizations/r2")).json.accountId;
  const fresh = (await host.api("GET", `/v1/connections/accounts/${newId}`)).json;
  assert.equal(fresh.previousAccountId, oldId); assert.equal(fresh.identityChanged, true);
  assert.deepEqual(fresh.bots, [{ botId: bot.id, access: "disabled", toolNames: [] }], "bot access never transfers implicitly");
  assert.equal((await host.api("GET", `/v1/connections/accounts/${oldId}`)).json.status, "replaced");
  assert.deepEqual(host.gateway.listTools(host.cap(bot.id).token), []);
});

test("restart: in-flight authorization becomes unknown, links are gone, accounts and grants persist", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc), bot = botIn(host);
  await connect(host, "k1");
  svc.composio.complete([...svc.composio.accounts.keys()][0]!);
  const accountId = (await host.api("GET", "/v1/connections/authorizations/k1")).json.accountId;
  const account = (await host.api("GET", `/v1/connections/accounts/${accountId}`)).json;
  await host.api("PATCH", `/v1/connections/accounts/${accountId}/access`, { expectedHostID: host.store.hostId, expectedRevision: account.revision, clientRequestId: "g1", botId: bot.id, enabled: true });
  const waiting = await connect(host, "k2");
  assert.equal(waiting.started.json.linkAvailable, true);
  await host.reopen();
  const after = await host.api("GET", "/v1/connections/authorizations/k2");
  assert.equal(after.json.state, "awaiting_user"); assert.equal(after.json.linkAvailable, false); assert.equal(after.json.authorizationURL, null);
  const persisted = (await host.api("GET", `/v1/connections/accounts/${accountId}`)).json;
  assert.equal(persisted.status, "connected"); assert.deepEqual(persisted.bots, [{ botId: bot.id, access: "enabled", toolNames: [READ.name, SEND.name].sort() }]);
  assert.equal(svc.composio.count("POST", "/api/v3.1/connected_accounts/link"), 2);
});

test("unconfigured host is honest; paired clients cannot reach connections administration", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc);
  const store = host.store;
  const http = await listen(createHostApp(store, { connections: connectionsHttpPort(() => unconfiguredConnectionsAdmin(store, null)) }));
  t.after(() => http.close());
  const get = async (path: string, init: RequestInit = {}) => { const r = await fetch(http.url + path, init); return { status: r.status, json: await r.json() }; };
  assert.equal((await get("/v1/connections/status")).json.platform, "unconfigured");
  const catalog = (await get("/v1/connections/catalog")).json;
  assert.deepEqual([catalog.platform, catalog.freshness, catalog.services], ["unconfigured", "never", []]);
  const post = await get("/v1/connections/authorizations", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedHostID: store.hostId, clientRequestId: "x", serviceId: "gmail", catalogPin: "a".repeat(64), profileId: null, label: null, replacesAccountId: null }) });
  assert.equal(post.status, 503);
  const absent = await listen(createHostApp(store, {}));
  t.after(() => absent.close());
  assert.equal((await fetch(absent.url + "/v1/connections/status")).status, 503);
  const authority = { principal: "paired-client" as const, installationId: store.hostId, ownerId: store.ownerId, deviceId: "dev", role: "owner-phone" as never,
    scopes: ["chat.read", "chat.write", "approvals.read", "approvals.decide", "devices.read", "devices.manage", "grants.read", "grants.manage"] as never,
    pinGeneration: 1, bindingRevision: 1, assertCurrent() {}, noteSelfRevoke() {} };
  const router = createAuthorizedHostRouter(store);
  for (const [method, path] of [["GET", "/v1/connections/status"], ["GET", "/v1/connections/accounts"], ["POST", "/v1/connections/authorizations"]] as const) {
    const response = await router.request(path, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) }, { authority });
    assert.equal(response.status, 403, path);
  }
  assert.throws(() => connectionsHttpPort(() => { throw new HostError("conflict", "closed"); }).status(), HostError);
});

test("catalog change: pinned attempts keep their reviewed snapshot; a stale pin is refused; seen content keeps its revision", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc); botIn(host);
  const first = await connect(host, "cat-1");
  assert.equal(first.catalog.revision, 1);
  svc.setCatalog([{ ...CATALOG[0]!, description: "E-mail do Google (revisado)." }]);
  await svc.restart(); await host.reopen();
  const changed = (await host.api("GET", "/v1/connections/catalog")).json;
  assert.notEqual(changed.pin, first.catalog.pin); assert.equal(changed.revision, 2);
  assert.equal((await connect(host, "cat-2", { catalogPin: first.catalog.pin })).started.status, 409, "the owner confirms again on the new catalog");
  svc.composio.complete([...svc.composio.accounts.keys()][0]!);
  const done = (await host.api("GET", "/v1/connections/authorizations/cat-1")).json;
  assert.equal(done.state, "connected"); assert.equal(done.catalogRevision, 1, "confirmation uses the snapshot the owner saw");
  svc.setCatalog(CATALOG); await svc.restart(); await host.reopen();
  const back = (await host.api("GET", "/v1/connections/catalog")).json;
  assert.equal(back.pin, first.catalog.pin); assert.equal(back.revision, 1, "same content, same revision identity");
});
