import assert from "node:assert/strict";
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import { NativeMcpRuntime, checkMcpDefinition } from "@dexter/connectors";
import { AuthorityCoordinator, LocalAuthorityController, openCheckpointArtifact } from "@dexter/operations";
import { checkFullSchema, FULL_SCHEMAS, nativeMcpSchemaLabel } from "../packages/operations/dist/full-schemas.js";
import { validateNativeMcp } from "../packages/operations/dist/native-mcp.js";
import { decodeCheckpointManifest } from "../packages/operations/dist/checkpoint.js";
import { resolveLimits } from "../packages/operations/dist/manifest.js";
import { mcpSetupHash, mcpSetupCanonicalJSON, mcpSetupInstancePin } from "../packages/connectors/dist/mcp/setup-receipts.js";

const definition = id => ({ id, name: "Synthetic registration", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: "https://synthetic.example.invalid/mcp" } });
const request = (id = "new-request", instance = "mail-one") => ({ requestId: id, expectedInstancePin: null, definition: definition(instance) });
const rows = (path, table = "setup_receipts") => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); } finally { db.close(); } };
const code = name => error => error?.code === name;
function fixture(t, legacy = false) {
  const root = mkdtempSync("/private/tmp/dexter-mcp-schema-backup-r2-synthetic-");
  const source = join(root, "source"), path = join(source, "native-mcp.sqlite");
  const counts = { fetch: 0, credentialRead: 0, oauthLoad: 0, oauthSave: 0, oauthRemove: 0 };
  let store = new HostStore({ dataDir: source }), runtime, gateway;
  const owner = () => ({ installationId: store.hostId, ownerId: store.ownerId, origin: { kind: "owner_local" } });
  const authority = owner();
  if (legacy) {
    const db = new DatabaseSync(path);
    try {
      db.exec(FULL_SCHEMAS.nativeMcp.sql.split("CREATE TABLE setup_receipts")[0]);
      for (const [key, value] of [["schema", "1"], ["installation", store.hostId], ["owner", store.ownerId]]) db.prepare("INSERT INTO meta VALUES (?,?)").run(key, value);
      for (const id of ["legacy", "legacy-null"]) db.prepare("INSERT INTO servers VALUES (?,?,'configured')").run(id, JSON.stringify(checkMcpDefinition(definition(id))));
      db.prepare("INSERT INTO meta VALUES (?,?)").run("mcp-instance:legacy", "11111111-1111-4111-8111-111111111111");
    } finally { db.close(); }
  }
  const closeRuntime = async () => { if (runtime) { await runtime.close(); runtime = undefined; } if (gateway) { gateway.close(); gateway = undefined; } };
  const open = dataDir => {
    if (dataDir) { store.close(); store = new HostStore({ dataDir }); }
    runtime = new NativeMcpRuntime({ host: { runsOn: "owner_mac", stdioRoot: join(root, "never-created"), fetch: async () => { counts.fetch++; throw new Error("synthetic unexpected fetch"); } },
      oauth: { store: { load: async () => { counts.oauthLoad++; throw new Error("unexpected token load"); }, save: async () => { counts.oauthSave++; throw new Error("unexpected token save"); }, remove: async () => { counts.oauthRemove++; throw new Error("unexpected token remove"); } } },
      credentials: { custody: { kind: "synthetic", read: async () => { counts.credentialRead++; throw new Error("unexpected credential read"); } } } });
    gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter });
    runtime.bind({ hostId: store.hostId, ownerId: store.ownerId, databasePath: store.databasePath,
      getBot: id => store.getBot(id), getGrant: (...args) => store.getGrant(...args), setGrant: value => store.setGrant(value), withWriterLease: operation => store.withWriterLease(operation) }, gateway);
  };
  t.after(async () => { await closeRuntime(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, source, path, counts, owner, authority, open, closeRuntime, get store() { return store; }, get admin() { return runtime.admin; }, get runtime() { return runtime; } };
}
function controller(t, h) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), secret = createSecretKey(randomBytes(32));
  const key = { keyId: "synthetic-mcp-r2-checkpoint", use: fn => fn(secret) }, owner = { publicKey, sign: bytes => sign(null, bytes, privateKey) };
  const coordinator = AuthorityCoordinator.open(join(h.root, "coordinator"), { ownerId: h.store.ownerId, ownerPublicKey: publicKey });
  t.after(() => coordinator.close());
  return { key, owner, control: new LocalAuthorityController({ coordinator }) };
}
function quiet(h) { assert.deepEqual(h.counts, { fetch: 0, credentialRead: 0, oauthLoad: 0, oauthSave: 0, oauthRemove: 0 }); assert.equal(existsSync(join(h.root, "never-created")), false); }

// No HostServices, engine, MCP session/socket, OAuth invocation or personal key storage. Only owned SQLite + first-party fences.
test("MCP R2: historical schema1 checkpoint/activation upgrades transactionally, preserves generations and replay on reopen", async t => {
  const h = fixture(t, true), { key, owner, control } = controller(t, h);
  const original = rows(h.path, "servers"), identity = h.authority;
  const db = new DatabaseSync(h.path, { readOnly: true });
  try { assert.equal(nativeMcpSchemaLabel(db), "native-mcp-v1"); assert.deepEqual(checkFullSchema(db, "nativeMcp"), { installationId: identity.installationId, ownerId: identity.ownerId }); } finally { db.close(); }
  const hold = await control.quiesce({ quiesceForMaintenance: async () => h.store });
  const artifact = join(h.root, "legacy.dxg8"), destination = join(h.root, "destination");
  const prepared = control.prepare(hold, { output: artifact, key });
  const decoded = openCheckpointArtifact(artifact, key);
  assert.equal(decoded.manifest.schemas.nativeMcp, "native-mcp-v1");
  assert.deepEqual(decoded.manifest.counts.nativeMcp, { servers: 2, catalogs: 0, selections: 0, connections: 0 });
  control.revokeSource({ store: h.store }, prepared.checkpointId, destination);
  control.activate({ artifact, key, receipt: control.issueReceipt(owner, prepared.checkpointId) });
  h.open(destination);
  const restoredPath = join(destination, "native-mcp.sqlite");
  assert.equal(rows(restoredPath, "meta").find(row => row.key === "schema").value, "2");
  assert.deepEqual(rows(restoredPath, "servers"), original); assert.deepEqual(rows(restoredPath), []);
  assert.equal(rows(restoredPath, "meta").find(row => row.key === "mcp-instance:legacy").value, "11111111-1111-4111-8111-111111111111");
  assert.equal(rows(restoredPath, "meta").some(row => row.key === "mcp-instance:legacy-null"), false);
  const receipt = h.admin.addServerWithReceipt(request(), h.owner());
  await h.closeRuntime(); h.open(destination);
  assert.deepEqual(h.admin.addServerWithReceipt(request(), h.owner()), receipt);
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "new-request" }, h.owner()), { receipt, instanceState: "registered" });
  assert.equal(rows(restoredPath).length, 1); assert.equal(rows(restoredPath, "servers").length, 3);
  assert.equal(h.runtime.openSessions, 0); quiet(h);
});

test("MCP R2: schema2 backup+activation keeps journal/provenance and deny pins, strips connection refs, exact replay only", async t => {
  const h = fixture(t); h.open();
  const bot = h.store.createBot({ name: "Synthetic", engine: "claude", profileId: "synthetic" });
  const origin = { installationId: h.store.hostId, ownerId: h.store.ownerId, origin: { kind: "harness_action", botId: bot.id, threadId: "thread-synthetic", turnId: "turn-synthetic", actionId: "action-synthetic", callId: "call-synthetic" } };
  const receipt = h.admin.addServerWithReceipt(request("origin-request"), origin);
  const originalRows = rows(h.path), originalMeta = rows(h.path, "meta");
  h.store.setGrant({ botId: bot.id, tool: "mcp.mail-one.read", destination: "synthetic-connection-reference", policy: "ask" });
  await h.closeRuntime();
  const seed = new DatabaseSync(h.path); try { seed.prepare("INSERT INTO connections VALUES (?,?,?)").run("mail-one", "synthetic", "synthetic-connection-reference"); } finally { seed.close(); }
  const { key, owner, control } = controller(t, h), hold = await control.quiesce({ quiesceForMaintenance: async () => h.store });
  const backup = join(h.root, "backup.dxg8"); control.backup(hold, { output: backup, key });
  const decoded = openCheckpointArtifact(backup, key);
  assert.equal(decoded.manifest.schemas.nativeMcp, "native-mcp-v2");
  assert.deepEqual(decoded.manifest.counts.nativeMcp, { servers: 1, catalogs: 0, selections: 0, connections: 0, setupReceipts: 1 });
  assert.equal(decoded.members.get("native-mcp.sqlite").includes(Buffer.from("synthetic-connection-reference")), false);
  assert.deepEqual(rows(h.path), originalRows); assert.deepEqual(rows(h.path, "meta"), originalMeta);
  assert.equal(rows(h.path, "connections").length, 1, "Only staged copies are sanitized");
  const manifest = structuredClone(decoded.manifest);
  manifest.counts.nativeMcp.setupReceipts = 4097;
  assert.throws(() => decodeCheckpointManifest(manifest, resolveLimits()), code("corrupt"));
  delete manifest.counts.nativeMcp.setupReceipts;
  assert.throws(() => decodeCheckpointManifest(manifest, resolveLimits()), code("corrupt"));
  const transfer = join(h.root, "transfer.dxg8"), destination = join(h.root, "destination");
  const nextHold = await control.quiesce({ quiesceForMaintenance: async () => h.store });
  const prepared = control.prepare(nextHold, { output: transfer, key });
  control.revokeSource({ store: h.store }, prepared.checkpointId, destination);
  control.activate({ artifact: transfer, key, receipt: control.issueReceipt(owner, prepared.checkpointId) });
  const restoredPath = join(destination, "native-mcp.sqlite");
  assert.deepEqual(rows(restoredPath), originalRows); assert.deepEqual(rows(restoredPath, "connections"), []);
  h.open(destination);
  assert.deepEqual(h.admin.registrationReceipt({ requestId: "origin-request" }, origin), { receipt, instanceState: "registered" });
  assert.deepEqual(h.admin.addServerWithReceipt(request("origin-request"), origin), receipt);
  assert.equal(h.admin.registrationReceipt({ requestId: "origin-request" }, h.owner()), null, "Another origin cannot claim the old effect");
  assert.throws(() => h.admin.addServerWithReceipt(request("origin-request", "other-id"), origin), code("invalid_request"));
  assert.throws(() => h.admin.registrationReceipt({ requestId: "origin-request" }, { ...origin, installationId: "other-installation" }), code("scope_mismatch"));
  assert.equal(h.store.getGrant(bot.id, "mcp.mail-one.read", "synthetic-connection-reference").policy, "deny");
  assert.equal(rows(restoredPath).length, 1); assert.equal(rows(restoredPath, "servers").length, 1); assert.equal(h.runtime.openSessions, 0);
  for (const forbidden of ["origin-request", "synthetic.example.invalid", "credential", "connection-reference", "harness_action"]) assert.equal(originalRows[0].receipt.includes(forbidden), false);
  quiet(h);
});

test("MCP R2: backup validator journal cap, checksum/native envelope and live generation association refuse tamper", async t => {
  const h = fixture(t); h.open(); const receipt = h.admin.addServerWithReceipt(request(), h.owner()); await h.closeRuntime();
  const mutate = (name, apply, expected = "reference_broken") => {
    const path = join(h.root, name + ".sqlite"); copyFileSync(h.path, path);
    const db = new DatabaseSync(path), hub = new DatabaseSync(h.store.databasePath, { readOnly: true });
    try { apply(db); assert.throws(() => validateNativeMcp(db, hub), code(expected)); } finally { db.close(); hub.close(); }
  };
  mutate("checksum", db => db.prepare("UPDATE setup_receipts SET receipt_hash=?").run("a".repeat(64)));
  mutate("request-envelope", db => {
    const body = { ...receipt, inputHash: "b".repeat(64) };
    db.prepare("UPDATE setup_receipts SET receipt=?,receipt_hash=?").run(mcpSetupCanonicalJSON(body), mcpSetupHash(body));
  });
  mutate("live-instance", db => {
    const body = { ...receipt, instanceId: "other-id" };
    db.prepare("UPDATE setup_receipts SET receipt=?,receipt_hash=?").run(mcpSetupCanonicalJSON(body), mcpSetupHash(body));
  });
  mutate("identity", db => db.prepare("UPDATE meta SET value='foreign-owner' WHERE key='owner'").run(), "identity_mismatch");
  mutate("catalog", db => db.exec("CREATE TABLE unexpected(value TEXT) STRICT"), "unsupported_schema");
  const capPath = join(h.root, "capacity.sqlite"); copyFileSync(h.path, capPath);
  const db = new DatabaseSync(capPath), hub = new DatabaseSync(h.store.databasePath, { readOnly: true });
  try {
    const insert = db.prepare("INSERT INTO setup_receipts VALUES (?,?,?,?,?)");
    const append = i => {
      const body = { ...receipt, receiptId: randomUUID(), generation: randomUUID(), requestIdHash: mcpSetupHash({ requestId: "bounded-" + i }) };
      body.requestKeyHash = mcpSetupHash({ operation: "mcp.register", originHash: body.originHash, requestIdHash: body.requestIdHash });
      body.instancePin = mcpSetupInstancePin(body.definitionPin, body.generation);
      insert.run(body.requestKeyHash, body.originHash, body.requestHash, mcpSetupCanonicalJSON(body), mcpSetupHash(body));
    };
    db.exec("BEGIN"); for (let i = 1; i < 4096; i++) append(i); db.exec("COMMIT");
    assert.equal(validateNativeMcp(db, hub).setupReceipts, 4096);
    append(4096); assert.throws(() => validateNativeMcp(db, hub), code("reference_broken"));
  } finally { db.close(); hub.close(); }
  // Malformed legacy never migrates partially; no journal or marker2 appears on failure.
  const broken = join(h.root, "broken-legacy"), brokenStore = new HostStore({ dataDir: broken });
  const badPath = join(broken, "native-mcp.sqlite"), bad = new DatabaseSync(badPath);
  try {
    bad.exec(FULL_SCHEMAS.nativeMcp.sql.split("CREATE TABLE setup_receipts")[0]);
    for (const [k,v] of [["schema", "1"], ["installation", brokenStore.hostId], ["owner", brokenStore.ownerId]]) bad.prepare("INSERT INTO meta VALUES (?,?)").run(k,v);
    bad.exec("CREATE TRIGGER tamper AFTER INSERT ON servers BEGIN DELETE FROM servers WHERE id=NEW.id; END;");
  } finally { bad.close(); }
  const runtime = new NativeMcpRuntime({ host: { runsOn: "owner_mac", stdioRoot: join(broken, "never-created"), fetch: async () => { h.counts.fetch++; throw new Error("never fetch"); } }, oauth: false });
  const gateway = new CapabilityGateway({ store: brokenStore, broker: runtime.broker, adapter: runtime.adapter });
  try {
    assert.throws(() => runtime.bind({ hostId: brokenStore.hostId, ownerId: brokenStore.ownerId, databasePath: brokenStore.databasePath, getBot: id => brokenStore.getBot(id), getGrant: (...args) => brokenStore.getGrant(...args), setGrant: v => brokenStore.setGrant(v), withWriterLease: op => brokenStore.withWriterLease(op) }, gateway), code("store_conflict"));
    assert.equal(rows(badPath, "meta").find(row => row.key === "schema").value, "1");
    const check = new DatabaseSync(badPath, { readOnly: true }); try { assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='setup_receipts'").get().n, 0); } finally { check.close(); }
  } finally { await runtime.close(); gateway.close(); brokenStore.close(); }
  quiet(h);
});
