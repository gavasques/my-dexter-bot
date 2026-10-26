import assert from "node:assert/strict";
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HostStore } from "@dexter/hub";
import { AuthorityCoordinator, LocalAuthorityController, OfflineMaintenance, captureCheckpointArtifact, openCheckpointArtifact, type OwnerAuthority, type SnapshotKey } from "@dexter/operations";
import { sealEnvelope, AUTHORITY_ENVELOPE_PURPOSE } from "../packages/operations/src/envelope.js";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fake-stdio-server.js", import.meta.url));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const custody = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = createSecretKey(randomBytes(32));
  const key: SnapshotKey = { keyId: "synthetic-mcp-checkpoint", use: fn => fn(secret) };
  const owner: OwnerAuthority = { publicKey, sign: bytes => sign(null, bytes, privateKey) };
  return { key, owner };
};
const rows = (path: string, table: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); } finally { db.close(); }
};

test("checkpoint v2: populated MCP backup and activation preserve portable config, deny grants, omit HOME, start no process", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-checkpoint-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), destination = join(root, "destination");
  const { key, owner } = custody();
  const services = new HostServices({ dataDir: source, enableEngines: true, enableMcp: true, nativeMcp: { runsOn: "owner_mac" } });
  t.after(() => services.shutdown());
  const bot = services.store.createBot({ name: "Synthetic", engine: "claude", profileId: "personal" });
  const admin = services.nativeMcpAdmin;
  admin.addServer({ definition: { id: "fake", name: "Fake", runsOn: "owner_mac", auth: "none", transport: { type: "stdio", command: process.execPath, args: [FIXTURE] } } });
  admin.addServer({ definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: "https://example.test/mcp", headers: { authorization: { kind: "secret", key: "token", prefix: "Bearer " } } } } });
  assert.equal((await admin.discover("fake")).server.status, "ready");
  admin.setBotSelection("fake", bot.id, { toolIds: ["mcp.fake.echo_text"], policy: "ask" });
  const original = Object.fromEntries(["servers", "catalogs", "selections", "connections"].map(table => [table, rows(join(source, "native-mcp.sqlite"), table)]));
  assert.equal(original.connections!.length, 1);
  const homeLog = join(source, "mcp-stdio", "fake", "calls.log");
  const log = readFileSync(homeLog);
  writeFileSync(join(source, "mcp-stdio", "fake", "private-cache"), "synthetic cache must not enter artifact", { mode: 0o600 });
  const coordinator = AuthorityCoordinator.open(join(root, "coordinator"), { ownerId: services.store.ownerId, ownerPublicKey: owner.publicKey });
  t.after(() => coordinator.close());
  const controller = new LocalAuthorityController({ coordinator });
  const hold = await controller.quiesce(services);
  const backupPath = join(root, "backup.dxg8");
  controller.backup(hold, { output: backupPath, key });
  const backup = openCheckpointArtifact(backupPath, key);
  assert.equal(backup.manifest.version, 2);
  assert.equal(backup.manifest.coverage.nativeMcp, "included");
  assert.deepEqual(backup.manifest.counts.nativeMcp, { servers: 2, catalogs: 1, selections: 1, connections: 0, setupReceipts: 0, instanceSelectionHeads: 0, instanceSelectionReceipts: 0 });
  assert.ok(backup.manifest.excluded.present.includes("mcp-stdio"));
  assert.ok([...backup.members.keys()].every(name => !name.includes("mcp-stdio")));
  assert.ok([...backup.members.values()].every(bytes => !bytes.includes(Buffer.from("synthetic cache must not enter artifact"))));
  for (const table of Object.keys(original)) assert.deepEqual(rows(join(source, "native-mcp.sqlite"), table), original[table], "source remains unchanged");
  assert.equal(rows(join(source, "dexter.sqlite"), "grants").filter(row => row.tool === "mcp.fake.echo_text")[0]!.policy, "ask");
  const transferPath = join(root, "transfer.dxg8");
  // Backup advanced the source epoch; refresh the trusted hold's authority before the next checkpoint.
  const nextHold = await controller.quiesce({ quiesceForMaintenance: async () => hold.store });
  const prepared = controller.prepare(nextHold, { output: transferPath, key });
  controller.revokeSource({ store: hold.store }, prepared.checkpointId, destination);
  controller.activate({ artifact: transferPath, key, receipt: controller.issueReceipt(owner, prepared.checkpointId) });
  for (const table of ["servers", "catalogs", "selections"]) assert.deepEqual(rows(join(destination, "native-mcp.sqlite"), table), original[table]);
  assert.deepEqual(rows(join(destination, "native-mcp.sqlite"), "connections"), []);
  assert.ok(rows(join(destination, "dexter.sqlite"), "grants").filter(row => String(row.tool).startsWith("mcp.")).every(row => row.policy === "deny"));
  assert.equal(statSync(join(destination, "native-mcp.sqlite")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(destination, "mcp-stdio")), false);
  const restored = new HostServices({ dataDir: destination, enableEngines: true, enableMcp: true, nativeMcp: { runsOn: "owner_mac" } });
  try {
    assert.equal(restored.nativeMcpAdmin.listServers().length, 2);
    assert.deepEqual(restored.nativeMcpAdmin.botSelection("fake", bot.id).toolIds, ["mcp.fake.echo_text"]);
    assert.equal(existsSync(join(destination, "mcp-stdio")), false, "startup/list/selection read start no child");
    assert.deepEqual(rows(join(destination, "native-mcp.sqlite"), "connections"), []);
    assert.equal(restored.store.getGrant(bot.id, "mcp.fake.echo_text", String(original.connections![0]!.connection_id))!.policy, "deny");
  } finally { await restored.shutdown(); }
  assert.deepEqual(readFileSync(homeLog), log, "backup/activation/restart did not spawn at source either");
});

test("historical checkpoint v1 still decodes and activates with native MCP absent", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-checkpoint-v1-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), destination = join(root, "destination"), artifact = join(root, "legacy.dxg8");
  const { key, owner } = custody();
  const store = new HostStore({ dataDir: source }); store.createBot({ name: "Synthetic", engine: "claude", profileId: "personal" }); const ownerId = store.ownerId; store.close();
  const coordinator = AuthorityCoordinator.open(join(root, "coordinator"), { ownerId, ownerPublicKey: owner.publicKey });
  t.after(() => coordinator.close());
  const maintenance = new OfflineMaintenance(source); t.after(() => maintenance.close());
  const controller = new LocalAuthorityController({ coordinator });
  const hold = await controller.quiesce(maintenance);
  const checkpointId = "ckp_syntheticLegacyCheckpoint0001";
  coordinator.beginCheckpoint({ installationId: hold.store.hostId, ownerId, epoch: hold.authority.epoch, state: "active", directory: source, checkpointId: null }, checkpointId, Date.now());
  const checkpoint = hold.store.checkpointForTransfer(checkpointId);
  captureCheckpointArtifact({ source: hold.store, checkpoint, key, output: artifact });
  const opened = openCheckpointArtifact(artifact, key);
  const legacy = JSON.parse(JSON.stringify(opened.manifest)) as Record<string, any>;
  legacy.version = 1; delete legacy.coverage.nativeMcp; delete legacy.counts.nativeMcp;
  const manifest = Buffer.from(JSON.stringify(legacy)); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(manifest.length);
  const envelope = sealEnvelope(Buffer.concat([prefix, manifest, ...legacy.members.map((member: { name: string }) => opened.members.get(member.name)!)]), key, AUTHORITY_ENVELOPE_PURPOSE);
  writeFileSync(artifact, envelope, { mode: 0o600 });
  coordinator.recordCaptured(checkpointId, sha(envelope), sha(manifest), Date.now());
  const decoded = openCheckpointArtifact(artifact, key);
  assert.equal(decoded.manifest.version, 1); assert.equal(decoded.manifest.coverage.nativeMcp, "absent"); assert.equal(decoded.manifest.counts.nativeMcp, null);
  controller.revokeSource({ store: hold.store }, checkpointId, destination);
  const activated = controller.activate({ artifact, key, receipt: controller.issueReceipt(owner, checkpointId) });
  assert.equal(activated.epoch, 2); assert.equal(activated.coverage.nativeMcp, "absent");
  assert.equal(existsSync(join(destination, "native-mcp.sqlite")), false);
  const restored = new HostStore({ dataDir: destination }); try { assert.equal(restored.listBots().length, 1); } finally { restored.close(); }
});
