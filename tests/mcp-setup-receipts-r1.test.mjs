import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import { NativeMcpRuntime, NATIVE_MCP_DATABASE_FILE } from "../packages/connectors/dist/mcp/manager.js";
import { checkMcpDefinition, mcpConnectInput } from "../packages/connectors/dist/mcp/definition.js";
import { mcpSetupHash, mcpSetupInstancePin, NATIVE_MCP_RECEIPTS_SQL, validateMcpSetupSchema } from "../packages/connectors/dist/mcp/setup-receipts.js";

// Entirely synthetic; no upstream request, process, actual account or private credential operation.
const definition = (id = "gmail-one", name = "Conta sintética 日本語 😀") => ({
  id, name, runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: "https://synthetic.example.invalid/mcp" },
});
const request = (requestId, value = definition()) => ({ requestId, expectedInstancePin: null, definition: value });
const code = expected => error => error?.code === expected;
const rows = (path, sql = "SELECT * FROM setup_receipts") => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};

async function fixture(t, withOAuth = false) {
  const root = mkdtempSync("/private/tmp/dexter-mcp-setup-receipts-r1-synthetic-");
  let store, runtime, gateway;
  const counts = { fetch: 0, custody: 0, grants: 0, revocations: 0, leases: 0, oauth: 0 };
  let rejectWriter = false, responseLost = false;
  const open = () => {
    store = new HostStore({ dataDir: root });
    runtime = new NativeMcpRuntime({
      host: { runsOn: "owner_mac", stdioRoot: join(root, "mcp-stdio"), fetch: async () => { counts.fetch++; throw new Error("unexpected upstream"); } },
      oauth: withOAuth ? { store: {
        load: async () => { counts.oauth++; throw new Error("unexpected OAuth custody"); },
        save: async () => { counts.oauth++; throw new Error("unexpected OAuth custody"); },
        remove: async () => { counts.oauth++; throw new Error("unexpected OAuth custody"); },
      } } : false,
      credentials: { custody: { kind: "synthetic", read: async () => { counts.custody++; throw new Error("unexpected custody"); } } },
    });
    gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter });
    const revoke = gateway.revokeConnection.bind(gateway);
    gateway.revokeConnection = (...args) => { counts.revocations++; return revoke(...args); };
    runtime.bind({
      hostId: store.hostId, ownerId: store.ownerId, databasePath: store.databasePath,
      getBot: id => store.getBot(id), getGrant: (...args) => store.getGrant(...args),
      setGrant: value => { counts.grants++; return store.setGrant(value); },
      withWriterLease: operation => {
        counts.leases++;
        if (rejectWriter) throw new Error("synthetic canonical writer fenced");
        const result = store.withWriterLease(operation);
        if (responseLost && result?.operation === "mcp.register") { responseLost = false; throw new Error("synthetic post-commit response lost"); }
        return result;
      },
    }, gateway);
  };
  const close = async () => {
    rejectWriter = false;
    if (runtime) { await runtime.close(); runtime = null; }
    if (gateway) { gateway.close(); gateway = null; }
    if (store) { store.close(); store = null; }
  };
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  open();
  return {
    root, path: join(root, NATIVE_MCP_DATABASE_FILE), counts, open, close,
    get store() { return store; }, get admin() { return runtime.admin; }, get runtime() { return runtime; }, get gateway() { return gateway; },
    owner: () => ({ installationId: store.hostId, ownerId: store.ownerId, origin: { kind: "owner_local" } }),
    action: (suffix = "a") => ({ installationId: store.hostId, ownerId: store.ownerId,
      origin: { kind: "harness_action", botId: `bot-${suffix}`, threadId: `thread-${suffix}`, turnId: `turn-${suffix}`, actionId: `action-${suffix}`, callId: `call-${suffix}` } }),
    fence: value => { rejectWriter = value; }, loseResponse: () => { responseLost = true; },
  };
}

test("3-A: same endpoint, distinct instances/generations, exact replay and changed input", async t => {
  const h = await fixture(t);
  const authority = h.owner();
  assert.equal(h.admin.registrationReceipt({ requestId: "not-yet" }, authority), null);
  assert.deepEqual(h.admin.registrationJournalStatus(authority), { version: 1, used: 0, limit: 4096, remaining: 4096, registrationCapacity: "available" });
  assert.equal(existsSync(h.path), false, "query of empty inventory does not create a database");
  const one = h.admin.addServerWithReceipt(request("request-one"), authority);
  const two = h.admin.addServerWithReceipt(request("request-two", definition("gmail-two")), authority);
  assert.notEqual(one.generation, two.generation);
  assert.notEqual(one.instancePin, two.instancePin);
  assert.equal(h.admin.instancePin("gmail-one"), one.instancePin, "existing canonical pin remains compatible");
  assert.deepEqual(h.admin.addServerWithReceipt(request("request-one"), authority), one);
  const reordered = Object.fromEntries(Object.entries(definition()).reverse());
  assert.deepEqual(h.admin.addServerWithReceipt(request("request-one", reordered), authority), one, "canonical key order is stable");
  assert.throws(() => h.admin.addServerWithReceipt(request("request-one", { ...definition(), readOnlyTools: [] }), authority), code("invalid_request"), "changed input is refused even if normalization would have the same effect");
  assert.throws(() => h.admin.addServerWithReceipt(request("request-one", definition("gmail-one", "changed")), authority), code("invalid_request"));
  assert.equal(rows(h.path).length, 2);
  assert.equal(rows(h.path, "SELECT id FROM servers").length, 2);
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
  assert.equal(h.runtime.openSessions, 0);
  assert.equal(h.gateway.registry.listConnections().length, 0);
  assert.equal(existsSync(join(h.root, "mcp-stdio")), false);
  const serialized = JSON.stringify(one);
  for (const value of ["synthetic.example.invalid", "日本語", "transport", "headers", "Conta", "owner_local"]) assert.equal(serialized.includes(value), false);
  await h.close(); h.open();
  const before = h.counts.leases;
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "request-one" }, h.owner()), { receipt: one, instanceState: "registered" });
  assert.equal(h.counts.leases, before, "receipt query is read-only and does not enter the writer");
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});

test("3-A: configured OAuth custody is untouched by registration, receipt query, replay and reopen", async t => {
  const h = await fixture(t, true), authority = h.owner();
  const receipt = h.admin.addServerWithReceipt(request("no-oauth"), authority);
  assert.deepEqual(h.admin.addServerWithReceipt(request("no-oauth"), authority), receipt);
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "no-oauth" }, authority), { receipt, instanceState: "registered" });
  await h.close(); h.open();
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "no-oauth" }, h.owner()), { receipt, instanceState: "registered" });
  assert.equal(h.counts.oauth + h.counts.custody + h.counts.fetch, 0);
  assert.equal(h.runtime.openSessions, 0);
  assert.equal(existsSync(join(h.root, "mcp-stdio")), false);
});

test("3-A: lost response after commit is recovered by read only, after reopen, without another INSERT", async t => {
  const h = await fixture(t), input = request("commit-loss"), authority = h.action();
  h.loseResponse();
  assert.throws(() => h.admin.addServerWithReceipt(input, authority), /post-commit response lost/);
  const original = JSON.parse(rows(h.path)[0].receipt);
  assert.equal(rows(h.path, "SELECT id FROM servers").length, 1);
  assert.equal(h.admin.listServers().length, 0, "lost return occurred before the runtime memory mirror");
  const before = h.counts.leases;
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "commit-loss" }, authority), { receipt: original, instanceState: "registered" });
  assert.equal(h.counts.leases, before);
  await h.close(); h.open();
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "commit-loss" }, h.action()), { receipt: original, instanceState: "registered" });
  assert.deepEqual(h.admin.addServerWithReceipt(input, h.action()), original);
  assert.equal(rows(h.path).length, 1);
  assert.equal(rows(h.path, "SELECT id FROM servers").length, 1);
  assert.equal(h.runtime.openSessions, 0);
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});

test("3-A: remove/recreate never associates an old receipt with the new generation or resurrects it", async t => {
  const h = await fixture(t), input = request("old"), authority = h.owner();
  const old = h.admin.addServerWithReceipt(input, authority);
  h.admin.addServerWithReceipt(request("other", definition("gmail-two")), authority);
  await h.admin.removeServer("gmail-one");
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "old" }, authority), { receipt: old, instanceState: "removed" });
  assert.deepEqual(h.admin.addServerWithReceipt(input, authority), old);
  assert.deepEqual(h.admin.listServers().map(server => server.id), ["gmail-two"]);
  const replacement = h.admin.addServerWithReceipt(request("replacement"), authority);
  assert.notEqual(replacement.generation, old.generation);
  assert.notEqual(replacement.instancePin, old.instancePin);
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "old" }, authority), { receipt: old, instanceState: "replaced" });
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "replacement" }, authority), { receipt: replacement, instanceState: "registered" });
  assert.deepEqual(h.admin.addServerWithReceipt(input, authority), old);
  assert.equal(h.admin.instancePin("gmail-one"), replacement.instancePin);
  assert.equal(h.admin.listServers().length, 2);
  await h.close(); h.open();
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "old" }, h.owner()), { receipt: old, instanceState: "replaced" });
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});

test("3-A: foreign host/owner/origin and model authority/source fields refuse without effect", async t => {
  const h = await fixture(t), input = request("authority"), trusted = h.action();
  const receipt = h.admin.addServerWithReceipt(input, trusted);
  for (const authority of [{ ...trusted, installationId: "wrong-host" }, { ...trusted, ownerId: "wrong-owner" }]) {
    assert.throws(() => h.admin.registrationReceipt({ requestId: "authority" }, authority), code("scope_mismatch"));
    assert.throws(() => h.admin.addServerWithReceipt(request("foreign", definition("foreign")), authority), code("scope_mismatch"));
  }
  for (const field of ["botId", "threadId", "turnId", "actionId", "callId"]) {
    const authority = { ...trusted, origin: { ...trusted.origin, [field]: `different-${field}` } };
    assert.equal(h.admin.registrationReceipt({ requestId: "authority" }, authority), null);
  }
  assert.equal(h.admin.registrationReceipt({ requestId: "authority" }, h.owner()), null);
  for (const key of ["ownerId", "installationId", "botId", "origin", "source", "authority"]) {
    assert.throws(() => h.admin.addServerWithReceipt({ ...request("extra", definition("extra")), [key]: "invented" }, h.owner()), code("invalid_request"));
  }
  assert.throws(() => h.admin.addServerWithReceipt(request("source", { ...definition("source"), source: { format: "manual", name: "invented" } }), h.owner()), code("invalid_request"));
  assert.throws(() => h.admin.addServerWithReceipt({ ...request("cas", definition("cas")), expectedInstancePin: receipt.instancePin }, h.owner()), code("invalid_request"));
  assert.throws(() => h.admin.addServerWithReceipt(request("utf", definition("utf", "broken\ud800")), h.owner()), code("invalid_request"));
  assert.equal(rows(h.path).length, 1);
  assert.equal(rows(h.path, "SELECT id FROM servers").length, 1);
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});

test("3-A: writer lease fencing, read only while fenced, and closed admission", async t => {
  const h = await fixture(t), authority = h.owner();
  const receipt = h.admin.addServerWithReceipt(request("before-fence"), authority);
  h.fence(true);
  assert.throws(() => h.admin.addServerWithReceipt(request("fenced", definition("fenced")), authority), /writer fenced/);
  const before = h.counts.leases;
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "before-fence" }, authority), { receipt, instanceState: "registered" });
  assert.equal(h.counts.leases, before);
  assert.equal(rows(h.path).length, 1);
  assert.throws(() => new HostStore({ dataDir: h.root }), /lease|writer|lock/i, "canonical lease cannot be taken by another writer");
  const retained = h.admin;
  h.runtime.stopAdmission();
  assert.throws(() => retained.addServerWithReceipt(request("closed", definition("closed")), authority), code("closed"));
  assert.throws(() => retained.registrationReceipt({ requestId: "before-fence" }, authority), code("closed"));
  assert.equal(rows(h.path).length, 1);
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});

test("3-A: refusal/query and removal of one instance preserve the other gateway connection and grant", async t => {
  const h = await fixture(t), authority = h.owner();
  const one = definition(), two = definition("gmail-two");
  const first = h.admin.addServerWithReceipt(request("first", one), authority);
  h.admin.addServerWithReceipt(request("second", two), authority);
  const bot = h.store.createBot({ name: "Synthetic", profileId: "synthetic", engine: "codex" });
  const connection = value => h.gateway.connectAccount(mcpConnectInput(checkMcpDefinition(value), {
    profileId: bot.profileId, label: "Synthetic", credentialRef: `mcp-oauth:${value.id}`,
  }));
  const firstConnection = connection(one), secondConnection = connection(two);
  const grant = h.store.setGrant({ botId: bot.id, tool: "mcp.gmail-two.synthetic_read", destination: secondConnection.id, policy: "ask" });
  assert.throws(() => h.admin.addServerWithReceipt(request("foreign", definition("foreign")), { ...authority, ownerId: "wrong" }), code("scope_mismatch"));
  h.admin.registrationReceipt({ requestId: "first" }, authority);
  assert.equal(h.counts.revocations, 0);
  assert.deepEqual(h.store.getGrant(bot.id, grant.tool, secondConnection.id), grant);
  await h.admin.removeServer("gmail-one");
  assert.equal(h.gateway.registry.getConnection(firstConnection.id).status, "revoked");
  assert.deepEqual(h.gateway.registry.getConnection(secondConnection.id), secondConnection);
  assert.deepEqual(h.store.getGrant(bot.id, grant.tool, secondConnection.id), grant);
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "first" }, authority), { receipt: first, instanceState: "removed" });
  assert.equal(h.counts.revocations, 1, "only the requested instance was revoked");
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants, 0);
});

test("3-A: strict journal/schema tamper fails closed on read/write/reopen", async t => {
  const h = await fixture(t), authority = h.owner();
  h.admin.addServerWithReceipt(request("tamper"), authority);
  const db = new DatabaseSync(h.path);
  const altered = new DatabaseSync(":memory:");
  try {
    altered.exec(V1.replace("'ready'", "'READY'"));
    altered.exec(NATIVE_MCP_RECEIPTS_SQL);
    assert.throws(() => validateMcpSetupSchema(altered, "2"), code("store_conflict"), "case-sensitive CHECK literals cannot be normalized away");
  } finally { altered.close(); }
  db.prepare("UPDATE setup_receipts SET receipt_hash=?").run("0".repeat(64));
  db.close();
  assert.throws(() => h.admin.registrationReceipt({ requestId: "tamper" }, authority), code("store_conflict"));
  assert.throws(() => h.admin.addServerWithReceipt(request("after-tamper", definition("after-tamper")), authority), code("store_conflict"));
  assert.equal(rows(h.path, "SELECT id FROM servers").length, 1);
  await h.close();
  assert.throws(() => h.open(), code("store_conflict"));
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});

test("3-A: receipt bound rolls back both definition and generation atomically", async t => {
  const h = await fixture(t), authority = h.owner();
  const firstReceipt = h.admin.addServerWithReceipt(request("first"), authority);
  // Synthetic bound fixture: distinct trusted request keys retain immutable rows; no personal payloads.
  const db = new DatabaseSync(h.path), original = JSON.parse(db.prepare("SELECT receipt FROM setup_receipts").get().receipt);
  for (let i = 1; i < 4096; i++) {
    const requestIdHash = mcpSetupHash({ requestId: `synthetic-${i}` });
    const generation = randomUUID();
    const receipt = { ...original, receiptId: randomUUID(), generation, instancePin: mcpSetupInstancePin(original.definitionPin, generation), requestIdHash, requestKeyHash: mcpSetupHash({ operation: "mcp.register", originHash: original.originHash, requestIdHash }) };
    const canonical = Object.fromEntries(Object.entries(receipt).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    db.prepare("INSERT INTO setup_receipts VALUES (?,?,?,?,?)").run(receipt.requestKeyHash, receipt.originHash, receipt.requestHash, JSON.stringify(canonical), mcpSetupHash(receipt));
  }
  db.close();
  const leasesBefore = h.counts.leases;
  assert.deepEqual(h.admin.registrationJournalStatus(authority), { version: 1, used: 4096, limit: 4096, remaining: 0, registrationCapacity: "full" });
  assert.equal(h.counts.leases, leasesBefore, "capacity query is read only");
  assert.throws(() => h.admin.addServerWithReceipt(request("overflow", definition("overflow")), authority), code("server_limit"));
  assert.deepEqual(h.admin.addServerWithReceipt(request("first"), authority), firstReceipt, "full journal permits replay without a new receipt");
  assert.equal(rows(h.path, "SELECT id FROM servers").length, 1);
  assert.equal(rows(h.path, "SELECT value FROM meta WHERE key='mcp-instance:overflow'").length, 0);
  assert.equal(rows(h.path).length, 4096);
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});

const V1 = `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE servers(id TEXT PRIMARY KEY, definition TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('configured','ready','failed','needs_auth','deleting'))) STRICT;
CREATE TABLE catalogs(server_id TEXT PRIMARY KEY, tools TEXT NOT NULL) STRICT;
CREATE TABLE connections(server_id TEXT NOT NULL, profile_id TEXT NOT NULL, connection_id TEXT NOT NULL, PRIMARY KEY(server_id, profile_id)) STRICT;
CREATE TABLE selections(server_id TEXT NOT NULL, bot_id TEXT NOT NULL, tools TEXT NOT NULL, PRIMARY KEY(server_id, bot_id)) STRICT;`;
test("3-A: v1 migration preserves definitions and existing/absent generation pins; malformed v1 is not repaired", async t => {
  const h = await fixture(t), authority = h.owner();
  await h.close();
  const db = new DatabaseSync(h.path);
  db.exec(V1);
  for (const [key, value] of [["schema", "1"], ["installation", authority.installationId], ["owner", authority.ownerId]]) db.prepare("INSERT INTO meta VALUES (?,?)").run(key, value);
  const legacy = checkMcpDefinition(definition("legacy")), noGeneration = checkMcpDefinition(definition("legacy-null"));
  for (const d of [legacy, noGeneration]) db.prepare("INSERT INTO servers VALUES (?,?,'configured')").run(d.id, JSON.stringify(d));
  const generation = "11111111-1111-4111-8111-111111111111";
  db.prepare("INSERT INTO meta VALUES (?,?)").run("mcp-instance:legacy", generation);
  db.close();
  h.open();
  assert.equal(rows(h.path, "SELECT value FROM meta WHERE key='schema'")[0].value, "2");
  assert.equal(h.admin.instancePin("legacy"), mcpSetupInstancePin(mcpSetupHash(legacy), generation));
  assert.equal(h.admin.instancePin("legacy-null"), mcpSetupInstancePin(mcpSetupHash(noGeneration), null));
  assert.deepEqual(rows(h.path), [], "migration does not invent effects or authentication history");
  assert.equal(h.admin.registrationReceipt({ requestId: "legacy" }, h.owner()), null);
  assert.equal(rows(h.path, "SELECT definition FROM servers WHERE id='legacy'")[0].definition, JSON.stringify(legacy));
  await h.close();
  const altered = new DatabaseSync(h.path);
  altered.exec("DROP TABLE setup_receipts; UPDATE meta SET value='1' WHERE key='schema'; CREATE TRIGGER bad AFTER INSERT ON servers BEGIN DELETE FROM servers WHERE id=NEW.id; END;");
  altered.close();
  assert.throws(() => h.open(), code("store_conflict"));
  assert.equal(rows(h.path, "SELECT value FROM meta WHERE key='schema'")[0].value, "1", "failed migration rolled back its marker");
  assert.equal(rows(h.path, "SELECT name FROM sqlite_master WHERE name='setup_receipts'").length, 0);
  assert.equal(h.counts.fetch + h.counts.custody + h.counts.grants + h.counts.revocations, 0);
});
