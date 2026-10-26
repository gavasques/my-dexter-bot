import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import { ConnectionsRuntime } from "@dexter/connectors";
import { SERVICE_DATABASE_FILE } from "../packages/connections-service/src/index.js";
import { CATALOG, IDENTITY_ENDPOINT, LABEL_CATALOG, READ, SEND, SERVICE_ORIGIN, hostLab, remapFetch, serviceLab, type HostLab, type ServiceLab } from "./fixtures/connections-lab.js";

// UX-P1-11 over real loopback HTTP: app contract → host routes → trusted service → fake Composio v3.1 (documented shapes).
// Synthetic accounts and e-mails only; no real provider, account, key or login.
const email = (n: number) => `pessoa${n}@example.invalid`;
function botIn(host: HostLab, name: string) { return host.store.createBot({ name, profileId: "default", engine: "claude" }); }
/** Starts one authorization, lets the owner finish it at the provider and returns the confirmed account. */
async function connectOne(host: HostLab, svc: ServiceLab, id: string, displayName: string | null, mail: string | null, extra: Record<string, unknown> = {}) {
  const catalog = (await host.api("GET", "/v1/connections/catalog")).json;
  const started = await host.api("POST", "/v1/connections/authorizations", { expectedHostID: host.store.hostId, clientRequestId: id, serviceId: "gmail",
    catalogPin: catalog.pin, profileId: null, label: null, replacesAccountId: null, ...extra });
  assert.equal(started.status, 201, id);
  const ref = [...svc.composio.accounts.values()].find(a => a.status === "INITIATED")!.id;
  svc.composio.complete(ref, displayName, mail);
  const done = (await host.api("GET", `/v1/connections/authorizations/${id}`)).json;
  assert.equal(done.state, "connected", id);
  return { ref, account: (await host.api("GET", `/v1/connections/accounts/${done.accountId}`)).json };
}
const access = (host: HostLab, account: { id: string }, botId: string, enabled: boolean, clientRequestId: string) => host.api("GET", `/v1/connections/accounts/${account.id}`)
  .then(r => host.api("PATCH", `/v1/connections/accounts/${account.id}/access`, { expectedHostID: host.store.hostId, expectedRevision: r.json.revision, clientRequestId, botId, enabled }));
/** Engine view: the connection ids a bot can use right now. */
const usable = (host: HostLab, botId: string) => [...new Set(host.gateway.listTools(host.cap(botId).token).map(t => t.connectionId))].sort();
const executes = (svc: ServiceLab) => svc.composio.requests.filter(r => r.path.startsWith("/api/v3.1/tools/execute/") && !r.path.endsWith("/proxy"));
const proxied = (svc: ServiceLab) => svc.composio.requests.filter(r => r.path === "/api/v3.1/tools/execute/proxy");

test("identity adapter: verified only from the published endpoint read for THIS account; honest lower levels otherwise", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc); botIn(host, "A");
  const verified = await connectOne(host, svc, "v1", "Ana", email(1));
  assert.deepEqual({ ...verified.account.identity, checkedAt: typeof verified.account.identity.checkedAt },
    { confirmation: "provider_verified", value: email(1), kind: "email", source: "identity_endpoint", issuer: null, checkedAt: "number" });
  // Exactly one read, through the proxy, with this account, of the reviewed endpoint; never an arbitrary URL or a write.
  assert.deepEqual(proxied(svc).at(-1)!.body, { connected_account_id: verified.ref, endpoint: IDENTITY_ENDPOINT, method: "GET" });
  assert.equal(svc.composio.count("GET", "/api/v3.1/toolkits/gmail"), 1);
  // Invalid e-mail from the endpoint: never "verified"; the provider label is shown as a label.
  const invalid = await connectOne(host, svc, "v2", "Bia", "not-an-email");
  assert.deepEqual([invalid.account.identity.confirmation, invalid.account.identity.value, invalid.account.identity.source], ["provider_display_name", "Bia", "provider_label"]);
  // Endpoint read unavailable during confirmation: confirmed at the label level (the engine name below proves it); the next
  // live read of the account verifies it (first verification upgrades, never the reverse).
  svc.composio.faults.proxy = "500";
  const flaky = await connectOne(host, svc, "v3", "Caio", email(3));
  assert.deepEqual([flaky.account.identity.confirmation, flaky.account.identity.value, flaky.account.status], ["provider_verified", email(3), "connected"]);
  // Nothing at all: unconfirmed, no value invented from alias, account id or URL.
  const bare = await connectOne(host, svc, "v4", null, null);
  assert.deepEqual(bare.account.identity, { confirmation: "unconfirmed", value: null, kind: null, source: null, issuer: null, checkedAt: null });
  assert.ok(!JSON.stringify(bare.account.identity).includes(bare.ref));
  // The engine-visible name fixed at confirmation disambiguates accounts and never carries a token or link.
  const labels = [verified, invalid, flaky, bare].map(c => host.gateway.registry.getConnection(c.account.gatewayConnectionIds[0])!.label);
  assert.deepEqual(labels.slice(0, 3), [`Gmail · ${email(1)}`, "Gmail · Bia", "Gmail · Caio"]);
  assert.match(labels[3]!, /^Gmail · [0-9a-f]{8}$/);
  assert.equal(new Set(labels).size, 4);
});

test("identity adapter: a reviewed probe that Composio no longer publishes is never used; label-level catalog never probes", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc); botIn(host, "A");
  svc.composio.identityEndpoints.set("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/settings");
  const drifted = await connectOne(host, svc, "d1", "Ana", email(1));
  assert.equal(drifted.account.identity.confirmation, "provider_display_name");
  assert.equal(proxied(svc).length, 0, "no proxied read when the published endpoint differs from the reviewed probe");
  const plain = await serviceLab(t, { catalog: LABEL_CATALOG }), other = await hostLab(t, plain); botIn(other, "B");
  const label = await connectOne(other, plain, "l1", "Bruno", email(2));
  assert.equal(label.account.identity.confirmation, "provider_display_name");
  assert.equal(plain.composio.count("GET", "/api/v3.1/toolkits/"), 0);
  assert.equal(proxied(plain).length, 0);
});

test("five accounts of one app: distinct pins and names, per-account bot access and routing, restart, independent revoke", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc);
  const A = botIn(host, "A"), B = botIn(host, "B"), C = botIn(host, "C");
  const accounts = [];
  for (let n = 1; n <= 5; n++) accounts.push(await connectOne(host, svc, `m${n}`, `Pessoa ${n}`, email(n)));
  const conn = accounts.map(a => a.account.gatewayConnectionIds[0] as string);
  assert.equal(new Set(accounts.map(a => a.ref)).size, 5); assert.equal(new Set(conn).size, 5);
  assert.deepEqual(accounts.map(a => a.account.identity.value), [1, 2, 3, 4, 5].map(email));
  for (const a of accounts) assert.deepEqual(a.account.bots.map((b: { access: string }) => b.access), ["disabled", "disabled", "disabled"], "connecting grants nothing");
  // A → 1; B → 2, 3; C → all five. Each grant is its own CAS + receipt.
  let k = 0;
  for (const [bot, picks] of [[A, [0]], [B, [1, 2]], [C, [0, 1, 2, 3, 4]]] as const)
    for (const i of picks) assert.equal((await access(host, accounts[i]!.account, bot.id, true, `g${++k}`)).status, 200);
  const expected = () => ({ A: [conn[0]!].sort(), B: [conn[1]!, conn[2]!].sort(), C: [...conn].sort() });
  assert.deepEqual({ A: usable(host, A.id), B: usable(host, B.id), C: usable(host, C.id) }, expected());
  // The engine sees one entry per tool per account, named by the account; the owner sees the account behind each proposal.
  const views = host.gateway.listTools(host.cap(C.id).token).filter(v => v.name === READ.name);
  assert.deepEqual(views.map(v => v.connectionLabel).sort(), [1, 2, 3, 4, 5].map(n => `Gmail · ${email(n)}`).sort());
  const byConnection = new Map(accounts.map(a => [a.account.gatewayConnectionIds[0], a]));
  for (const [i, target] of conn.entries()) {
    const { token } = host.cap(C.id);
    const request = { tool: READ.name, connectionId: target, callId: `c${i}`, arguments: { query: "in:inbox" } };
    const pending = await host.gateway.call(token, request);
    assert.equal(pending.status, "awaiting_approval");
    const action = host.store.getAction(pending.actionId);
    const shown = (await host.api("GET", "/v1/connections/accounts")).json.items.find((a: { gatewayConnectionIds: string[] }) => a.gatewayConnectionIds.includes(action.request.destination));
    assert.equal(shown.identity.value, email(i + 1), "proposal → exactly the account the owner authorized");
    host.store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
    assert.equal((await host.gateway.call(token, request)).status, "succeeded");
    assert.equal((executes(svc).at(-1)!.body as { connected_account_id: string }).connected_account_id, byConnection.get(target)!.ref, "routed to that account only");
  }
  // A bot without the grant for account 2 never reaches it, even naming its connection id.
  const before = executes(svc).length;
  const refused = await host.gateway.call(host.cap(A.id).token, { tool: READ.name, connectionId: conn[1]!, callId: "x1", arguments: { query: "in:inbox" } }).catch((e: Error) => e);
  assert.ok(refused instanceof Error || (refused as { status: string }).status === "denied", JSON.stringify(refused));
  assert.equal(executes(svc).length, before);
  // Restart: identities, engine names and per-account access persist; nothing re-authorizes.
  const links = svc.composio.count("POST", "/api/v3.1/connected_accounts/link");
  await host.reopen();
  assert.deepEqual({ A: usable(host, A.id), B: usable(host, B.id), C: usable(host, C.id) }, expected());
  const listed = (await host.api("GET", "/v1/connections/accounts")).json.items;
  assert.deepEqual(listed.map((a: { identity: { value: string } }) => a.identity.value), [1, 2, 3, 4, 5].map(email));
  assert.equal(svc.composio.count("POST", "/api/v3.1/connected_accounts/link"), links);
  // Disconnecting account 2 stops only account 2.
  const second = (await host.api("GET", `/v1/connections/accounts/${accounts[1]!.account.id}`)).json;
  const cut = await host.api("POST", `/v1/connections/accounts/${second.id}/disconnect`, { expectedHostID: host.store.hostId, clientRequestId: "cut-2", expectedRevision: second.revision });
  assert.equal(cut.status, 200);
  assert.deepEqual({ A: usable(host, A.id), B: usable(host, B.id), C: usable(host, C.id) },
    { A: [conn[0]!], B: [conn[2]!], C: [conn[0]!, conn[2]!, conn[3]!, conn[4]!].sort() });
  for (const i of [0, 2, 3, 4]) assert.equal((await host.api("GET", `/v1/connections/accounts/${accounts[i]!.account.id}`)).json.status, "connected");
  // A sixth account of the same app is reachable by no bot until the owner authorizes it; its callback/readback grants nothing.
  const sixth = await connectOne(host, svc, "m6", "Pessoa 6", email(6));
  assert.deepEqual(sixth.account.bots.map((b: { access: string }) => b.access), ["disabled", "disabled", "disabled"]);
  const replay = await host.api("POST", "/v1/connections/authorizations/m6/callback", { expectedHostID: host.store.hostId, outcome: "returned", providerAccountRef: sixth.ref });
  assert.equal(replay.json.state, "connected");
  for (const bot of [A, B, C]) assert.ok(!usable(host, bot.id).includes(sixth.account.gatewayConnectionIds[0]));
});

test("identity drift on a verified account fails closed; reconnect shows the change and re-authorizes nothing", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc), bot = botIn(host, "A");
  const first = await connectOne(host, svc, "i1", "Ana", email(1));
  const steady = await connectOne(host, svc, "i2", "Bia", email(2));
  for (const [i, c] of [first, steady].entries()) assert.equal((await access(host, c.account, bot.id, true, `ga${i}`)).status, 200);
  // A weaker live read (endpoint temporarily unavailable) never downgrades a verified identity.
  svc.composio.faults.proxy = "500";
  const weak = (await host.api("GET", `/v1/connections/accounts/${steady.account.id}`)).json;
  assert.deepEqual([weak.identity.confirmation, weak.identity.value, weak.status], ["provider_verified", email(2), "connected"]);
  // The provider now verifies ANOTHER identity behind account 1: local stop, revision bump, no tools.
  const before = (await host.api("GET", `/v1/connections/accounts/${first.account.id}`)).json;
  svc.composio.accounts.get(first.ref)!.email = "outra.pessoa@example.invalid";
  const drifted = (await host.api("GET", `/v1/connections/accounts/${first.account.id}`)).json;
  assert.equal(drifted.status, "identity_mismatch"); assert.equal(drifted.revision, before.revision + 1);
  assert.equal(drifted.identity.value, email(1), "the account keeps the identity the owner authorized");
  assert.equal(host.gateway.registry.getConnection(first.account.gatewayConnectionIds[0])!.status, "revoked");
  assert.deepEqual(usable(host, bot.id), [steady.account.gatewayConnectionIds[0]]);
  // Never self-heals, even if the provider reports the original identity again; enabling access is refused.
  svc.composio.accounts.get(first.ref)!.email = email(1);
  assert.equal((await host.api("GET", `/v1/connections/accounts/${first.account.id}`)).json.status, "identity_mismatch");
  assert.equal((await access(host, first.account, bot.id, true, "re-enable")).status, 409);
  // Reconnect replacing it: new account, the app sees the identity change, bots start disabled.
  const fresh = await connectOne(host, svc, "i3", "Outra", "outra.pessoa@example.invalid", { replacesAccountId: first.account.id });
  assert.equal(fresh.account.previousAccountId, first.account.id); assert.equal(fresh.account.identityChanged, true);
  assert.deepEqual(fresh.account.bots, [{ botId: bot.id, access: "disabled", toolNames: [] }]);
  assert.equal((await host.api("GET", `/v1/connections/accounts/${first.account.id}`)).json.status, "replaced");
  // Same verified identity on reconnect: no change reported; access still has to be granted again.
  const again = await connectOne(host, svc, "i4", "Bia", email(2), { replacesAccountId: steady.account.id });
  assert.equal(again.account.identityChanged, false);
  assert.deepEqual(again.account.bots, [{ botId: bot.id, access: "disabled", toolNames: [] }]);
  assert.deepEqual(usable(host, bot.id), []);
});

test("friendly label: owner CAS + receipt + replay; engine name and grants unchanged; direct/disconnected refused", async t => {
  const svc = await serviceLab(t), host = await hostLab(t, svc), bot = botIn(host, "A");
  const { account } = await connectOne(host, svc, "n1", "Ana", email(1));
  assert.equal((await access(host, account, bot.id, true, "g1")).status, 200);
  const current = (await host.api("GET", `/v1/connections/accounts/${account.id}`)).json;
  const label = (body: Record<string, unknown>) => host.api("PATCH", `/v1/connections/accounts/${account.id}/label`, { expectedHostID: host.store.hostId, expectedRevision: current.revision, ...body });
  const receipt = await label({ clientRequestId: "lb1", label: "Trabalho" });
  assert.equal(receipt.status, 200);
  assert.deepEqual({ ...receipt.json, createdAt: 0, requestHash: "" }, { version: 1, hostId: host.store.hostId, clientRequestId: "lb1", kind: "label", accountId: account.id,
    requestHash: "", previousRevision: current.revision, revision: current.revision + 1, access: null, disconnect: null, label: "Trabalho", createdAt: 0 });
  assert.deepEqual((await label({ clientRequestId: "lb1", label: "Trabalho" })).json, receipt.json, "replay returns the original receipt");
  assert.equal((await label({ clientRequestId: "lb1", label: "Pessoal" })).status, 409, "same request id, different body");
  assert.equal((await label({ clientRequestId: "lb2", label: "Pessoal" })).status, 409, "stale revision");
  for (const bad of ["", "x".repeat(81), "a\u0007b"]) assert.equal((await label({ clientRequestId: "lb3", label: bad })).status, 400);
  assert.deepEqual((await host.api("GET", "/v1/connections/receipts/lb1")).json, receipt.json);
  const after = (await host.api("GET", `/v1/connections/accounts/${account.id}`)).json;
  assert.equal(after.label, "Trabalho"); assert.equal(after.identity.value, email(1), "a label is never an identity");
  assert.equal(host.gateway.registry.getConnection(account.gatewayConnectionIds[0])!.label, `Gmail · ${email(1)}`, "engine name fixed at confirmation");
  assert.deepEqual(after.bots, [{ botId: bot.id, access: "enabled", toolNames: [READ.name, SEND.name].sort() }]);
  assert.equal((await host.api("PATCH", "/v1/connections/accounts/mcp_remote/label", { expectedHostID: host.store.hostId, expectedRevision: 1, clientRequestId: "lb4", label: "x" })).status, 403);
  const cut = await host.api("POST", `/v1/connections/accounts/${account.id}/disconnect`, { expectedHostID: host.store.hostId, clientRequestId: "cut", expectedRevision: after.revision });
  assert.equal(cut.status, 200);
  assert.equal((await host.api("PATCH", `/v1/connections/accounts/${account.id}/label`, { expectedHostID: host.store.hostId, expectedRevision: cut.json.revision, clientRequestId: "lb5", label: "Velha" })).status, 409);
});

// Exact wave-1 (schema "1") DDL, used to rebuild a v1 database from synthetic v2 rows.
const V1_ACCOUNTS = `CREATE TABLE accounts(
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT NOT NULL, provider_account_ref TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL, toolkit TEXT NOT NULL, toolkit_version TEXT NOT NULL, tools TEXT NOT NULL, gateway_connection_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL, identity_confirmation TEXT NOT NULL, identity_value TEXT,
  status TEXT NOT NULL CHECK(status IN ('connected','needs_reconnect','disconnecting','disconnected','replaced','unknown')),
  status_checked_at INTEGER, attempt_id TEXT NOT NULL UNIQUE, previous_account_id TEXT, disconnect TEXT, pending_request TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;`;
const V1_RECEIPTS = `CREATE TABLE receipts(client_request_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('access','disconnect')), account_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;`;
const V1_COLUMNS = "id, service_id, provider, display_name, provider_account_ref, profile_id, toolkit, toolkit_version, tools, gateway_connection_id, label, identity_confirmation, identity_value, status, status_checked_at, attempt_id, previous_account_id, disconnect, pending_request, revision, created_at, updated_at";

test("connections.sqlite 1 → 2: explicit in-place migration keeps accounts, grants and receipts; unknown schema refused untouched", async t => {
  const svc = await serviceLab(t, { catalog: LABEL_CATALOG }), host = await hostLab(t, svc), bot = botIn(host, "A");
  const kept = await connectOne(host, svc, "w1", "Ana", null), gone = await connectOne(host, svc, "w2", "Bia", null);
  const granted = (await access(host, kept.account, bot.id, true, "p1")).json;
  const g = (await host.api("GET", `/v1/connections/accounts/${gone.account.id}`)).json;
  const cut = (await host.api("POST", `/v1/connections/accounts/${gone.account.id}/disconnect`, { expectedHostID: host.store.hostId, clientRequestId: "d1", expectedRevision: g.revision })).json;
  const snapshot = (await host.api("GET", "/v1/connections/accounts")).json.items;
  const path = join(host.dir, "connections.sqlite");
  const downgrade = () => {
    const db = new DatabaseSync(path);
    db.exec(`BEGIN IMMEDIATE; ${V1_ACCOUNTS.replace("TABLE accounts", "TABLE accounts_v1")}
      INSERT INTO accounts_v1 SELECT ${V1_COLUMNS} FROM accounts; DROP TABLE accounts; ALTER TABLE accounts_v1 RENAME TO accounts;
      ${V1_RECEIPTS.replace("TABLE receipts", "TABLE receipts_v1")}
      INSERT INTO receipts_v1 SELECT client_request_id, kind, account_id, request_hash, json_remove(body, '$.label'), created_at FROM receipts; DROP TABLE receipts;
      ALTER TABLE receipts_v1 RENAME TO receipts; DROP TABLE access_journal; UPDATE meta SET value='1' WHERE key='schema'; COMMIT;`);
    assert.ok(!(db.prepare("SELECT body FROM receipts WHERE client_request_id='p1'").get() as { body: string }).body.includes("label"));
    db.close();
  };
  const schema = () => { const db = new DatabaseSync(path); try { return (db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string }).value; } finally { db.close(); } };
  await host.reopen(async () => {
    downgrade();
    // A newer, unknown schema is refused before anything is touched.
    const db = new DatabaseSync(path); db.prepare("UPDATE meta SET value='99' WHERE key='schema'").run(); db.close();
    const store = new HostStore({ dataDir: host.dir });
    const runtime = new ConnectionsRuntime({ identity: { installationId: store.hostId, ownerId: store.ownerId }, credentialRef: "cred-connections",
      platform: { origin: SERVICE_ORIGIN, capability: () => host.capability, fetch: remapFetch({}), limits: { timeoutMs: 5_000 } } });
    const gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter });
    try { assert.throws(() => runtime.bind(store, gateway), (e: Error & { code?: string }) => e.code === "conflict"); }
    finally { await runtime.close().catch(() => undefined); gateway.close(); store.close(); }
    assert.equal(schema(), "99");
    const back = new DatabaseSync(path); back.prepare("UPDATE meta SET value='1' WHERE key='schema'").run(); back.close();
  });
  assert.equal(schema(), "3");
  // v1 had no identity timestamp: the migration records the last provider check as the identity check; everything else is equal.
  const migrated = (await host.api("GET", "/v1/connections/accounts")).json.items;
  for (const item of migrated) assert.equal(item.identity.checkedAt, item.statusCheckedAt);
  const sansCheck = (items: Array<{ identity: Record<string, unknown> }>) => items.map(i => ({ ...i, identity: { ...i.identity, checkedAt: null } }));
  assert.deepEqual(sansCheck(migrated), sansCheck(snapshot), "every account reads exactly as before");
  assert.deepEqual((await host.api("GET", "/v1/connections/receipts/p1")).json, granted, "receipt normalized to the v2 shape, byte-equal otherwise");
  assert.deepEqual((await host.api("GET", "/v1/connections/receipts/d1")).json, cut);
  assert.deepEqual(usable(host, bot.id), [kept.account.gatewayConnectionIds[0]]);
  // v2 behaviour on migrated data: labels and the new status are accepted.
  const current = (await host.api("GET", `/v1/connections/accounts/${kept.account.id}`)).json;
  assert.equal((await host.api("PATCH", `/v1/connections/accounts/${kept.account.id}/label`, { expectedHostID: host.store.hostId, expectedRevision: current.revision, clientRequestId: "lb", label: "Casa" })).status, 200);
});

test("connections-service.sqlite 1 → 2: explicit migration keeps attempts at the label level; unknown schema refused", async t => {
  const svc = await serviceLab(t, { catalog: CATALOG }), host = await hostLab(t, svc); botIn(host, "A");
  await connectOne(host, svc, "s1", "Ana", null);
  const principal = { installationId: host.store.hostId, ownerId: host.store.ownerId };
  const before = await svc.service.authorization(principal, "s1");
  assert.deepEqual(before.identity, { confirmation: "provider_display_name", value: "Ana", kind: "display_name", source: "provider_label" });
  const path = join(svc.dir, SERVICE_DATABASE_FILE);
  await svc.restart(() => {
    const db = new DatabaseSync(path);
    db.exec("BEGIN IMMEDIATE; ALTER TABLE attempts DROP COLUMN identity_kind; ALTER TABLE attempts DROP COLUMN identity_source; UPDATE meta SET value='1' WHERE key='schema'; COMMIT;");
    db.close();
  });
  assert.deepEqual(await svc.service.authorization(principal, "s1"), before);
  await assert.rejects(svc.restart(() => {
    const db = new DatabaseSync(path); db.prepare("UPDATE meta SET value='3' WHERE key='schema'").run(); db.close();
  }), /unsupported schema/);
  const db = new DatabaseSync(path);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string }).value, "3", "refused store left untouched");
  db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run(); db.close();
});
