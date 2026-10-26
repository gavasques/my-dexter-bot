// G8 authority (R6, extended R7): real local checkpoint/revocation/activation on real SQLite, real files and separate processes.
// Synthetic custody only (in-memory keys, sent to children over IPC, never written to a file).
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agenda } from "@dexter/agenda";
import { ContextHost, FixtureMemoryAdapter } from "@dexter/context";
import type { EngineId } from "@dexter/contracts";
import type { EngineDriver } from "@dexter/engines";
import { ClientPairingRegistry, DevicePairingRegistry } from "@dexter/devices";
import { ACTIVATION_MARKER_FILE, HostError, HostStore, SCHEMA_VERSION } from "@dexter/hub";
import {
  AuthorityCoordinator, INSPECTION_DIR, INSPECTION_FILES, LocalAuthorityController, OperationsError, captureInspectionSnapshot, openCheckpointArtifact, readSourceAuthority, restoreForInspection,
  runCli, signActivationReceipt, type ActivationReceipt, type MaintenanceQuiescePort, type MaintenanceStore, type OperationsErrorCode,
} from "@dexter/operations";
import type { RelayHostOptions } from "@dexter/relay-host";
import type { RelayTransport } from "@dexter/relay-consumer";
import { HostServices } from "../packages/cli/src/host-services.js";
import { gate, memoryCustody, memoryTLS } from "./fixtures/relay-host-lab.js";
import {
  CURRENT_CATALOG, LEASE_SENTINEL, OLD_ONLY_CATALOG, newCustody, seedDeviceSurface, seedInstallation, writeRelayAssociations, type TestCustody,
} from "./authority-fixture.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const CHILD = fileURLToPath(new URL("./authority-child.js", import.meta.url));
const BASE_HUB = process.env.G8_BASE_HUB_DIST;
const opCode = (expected: OperationsErrorCode) => (error: unknown): boolean => error instanceof OperationsError && error.code === expected;
const hostCode = (expected: string) => (error: unknown): boolean => error instanceof HostError && error.code === expected;
const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function workspace(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "g8auth-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// ---- separate processes ------------------------------------------------------------------------------------------
interface ChildResult { code: number | null; signal: NodeJS.Signals | null; messages: Json[] }
function spawnChild(role: string, args: object): { child: ReturnType<typeof fork>; messages: Json[]; next(): Promise<Json>; done: Promise<ChildResult> } {
  const child = fork(CHILD, [role, JSON.stringify(args)], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
  const messages: Json[] = []; const waiters: Array<(value: Json) => void> = [];
  child.on("message", (message) => { const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const done = new Promise<ChildResult>((resolve) => child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, messages }); }));
  return { child, messages, done, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve)) };
}
async function cliChild(argv: string[], custody?: TestCustody, extra: { crash?: string; now?: number; catalog?: unknown[]; destination?: string } = {}): Promise<ChildResult & { out: Json }> {
  const spawned = spawnChild("cli", { argv, ...extra });
  spawned.child.send(custody ? { custody: custody.wire } : {});
  const result = await spawned.done;
  const report = result.messages[0];
  return { ...result, out: report ? report.output[0] : null };
}
async function openChild(dataDir: string): Promise<Json> { const result = await spawnChild("open", { dataDir }).done; return result.messages[0]; }
async function cliIn(argv: string[], custody?: TestCustody, clock?: () => number, catalog?: unknown[]): Promise<{ code: number; out: Json }> {
  const lines: string[] = [];
  const code = await runCli(argv, {
    write: (line) => lines.push(line), ...(custody ? { custody: custody.provider } : {}), ...(clock ? { clock } : {}),
    ...(catalog ? { operationCatalog: catalog as never } : {}),
  });
  assert.equal(lines.length, 1, "exactly one output line");
  return { code, out: JSON.parse(lines[0]!) };
}
const okOut = (result: { code: number | null; out: Json }): Json => { assert.equal(result.out?.ok, true, JSON.stringify(result.out)); assert.equal(result.code, 0); return result.out; };

// ---- read-only state dumps ----------------------------------------------------------------------------------------
function immutable(path: string): DatabaseSync {
  const url = pathToFileURL(path); url.search = "immutable=1";
  return new DatabaseSync(url, { readOnly: true });
}
/** Every table of a closed database as sorted JSON rows (VACUUM may renumber implicit rowids). */
function tables(path: string): Record<string, string[]> {
  const db = immutable(path);
  try {
    const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Json[]).map((row) => String(row.name));
    return Object.fromEntries(names.map((name) => [name, (db.prepare(`SELECT * FROM "${name}"`).all() as Json[]).map((row) => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}
const rows = (path: string, sql: string): Json[] => { const db = immutable(path); try { return (db.prepare(sql).all() as Json[]).map((row) => ({ ...row })); } finally { db.close(); } };
/** Read-only through the WAL (a killed writer's last commits live there; `immutable` would not see them). */
const liveRows = (path: string, sql: string): Json[] => { const db = new DatabaseSync(path, { readOnly: true }); try { return (db.prepare(sql).all() as Json[]).map((row) => ({ ...row })); } finally { db.close(); } };
function tree(dir: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name; const stat = statSync(join(dir, relative));
    if (stat.isDirectory()) Object.assign(result, { [`${relative}/`]: "dir" }, tree(dir, relative));
    else result[relative] = sha(readFileSync(join(dir, relative)));
  }
  return result;
}
const parse = (lines: string[]): Json[] => lines.map((row) => JSON.parse(row));
const without = (lines: string[], ...keys: string[]): string[] => lines.map((row) => { const value = JSON.parse(row); for (const key of keys) delete value[key]; return JSON.stringify(value); }).sort();

interface Lab { root: string; data: string; coord: string; dest: string; art: string; rcpt: string; custody: TestCustody }
function lab(t: TestContext): Lab {
  const root = workspace(t);
  return { root, data: join(root, "source"), coord: join(root, "coordinator"), dest: join(root, "destination"), art: join(root, "checkpoint.dxg8"), rcpt: join(root, "receipt.json"), custody: newCustody() };
}
async function initPrepared(l: Lab): Promise<{ seeded: ReturnType<typeof seedInstallation>; checkpointId: string; prepared: Json }> {
  const seeded = seedInstallation(l.data);
  okOut(await cliIn(["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId], l.custody));
  const prepared = okOut(await cliIn(["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art], l.custody));
  return { seeded, checkpointId: prepared.checkpointId, prepared };
}
const coordinatorStatus = (l: Lab): Json => { const c = AuthorityCoordinator.open(l.coord); try { return c.status(); } finally { c.close(); } };

// =================================================================================================================

test("doctor and version are read-only and print only safe state", async (t) => {
  const l = lab(t);
  const seeded = seedInstallation(l.data);
  const before = tree(l.data);
  const out = okOut(await cliIn(["doctor", "--data-dir", l.data]));
  assert.deepEqual(tree(l.data), before, "doctor creates, changes and removes nothing");
  const report = out.doctor;
  assert.equal(report.hub.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(report.hub.authority, { state: "active", epoch: 1, provenance: "genesis", boundHere: true });
  assert.deepEqual(Object.fromEntries(Object.entries(report.components).map(([kind, value]: [string, Json]) => [kind, value.schema])), {
    context: "context-v1", agenda: "agenda-v2", deviceRegistry: "device-registry-v2", appClients: "app-clients-v1",
    relayConsumer: "relay-consumer-v1", relayAssociations: "relay-associations-v1",
  });
  assert.equal(report.contextRepository, true);
  assert.deepEqual(report.issues, []);
  const text = JSON.stringify(out);
  for (const secret of [seeded.hostId, seeded.ownerId, LEASE_SENTINEL, l.data, l.custody.wire.secret]) assert.ok(!text.includes(secret), "no id, path, cursor or key");
  const version = okOut(await cliIn(["version"]));
  assert.deepEqual({ hub: version.hubSchema, checkpoint: version.checkpointFormat, inspection: version.inspectionFormat }, { hub: 4, checkpoint: 1, inspection: 2 });
  // Usage errors and refusals print only a code.
  assert.deepEqual((await cliIn(["transfer", "prepare", "--data-dir", l.data])).out, { ok: false, error: "usage" });
  assert.deepEqual((await cliIn(["doctor", "--data-dir", l.data, "--data-dir", l.data])).out, { ok: false, error: "usage" });
});

test("shipped binary has no custody: every custody command fails closed before touching state", async (t) => {
  const l = lab(t);
  const seeded = seedInstallation(l.data);
  const before = tree(l.data);
  for (const argv of [
    ["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId],
    ["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art],
    ["backup", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art],
  ]) {
    const result = await cliChild(argv);
    assert.deepEqual(result.out, { ok: false, command: argv.slice(0, argv[0] === "backup" ? 1 : 2).join(" "), error: "authority_unavailable" });
  }
  assert.ok(!existsSync(l.coord) && !existsSync(l.art));
  assert.deepEqual(tree(l.data), before);
  // The real bin entry, with exactly the shipped (empty) provider.
  const bin = fileURLToPath(new URL("../../packages/operations/dist/bin.js", import.meta.url));
  const spawned = fork(bin, ["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = ""; spawned.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  const exit = await new Promise<number | null>((done) => spawned.on("exit", (code) => done(code)));
  assert.equal(exit, 1);
  assert.deepEqual(JSON.parse(stdout), { ok: false, command: "coordinator init", error: "authority_unavailable" });
});

test("full transfer in separate processes: exact public state at the destination, source permanently revoked", async (t) => {
  const l = lab(t);
  const seeded = seedInstallation(l.data);
  okOut(await cliChild(["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId], l.custody));
  const prepared = okOut(await cliChild(["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art], l.custody));
  assert.equal(prepared.sourceEpoch, 1);
  assert.deepEqual(prepared.coverage, {
    hub: "included", context: "included", agenda: "included", deviceRegistry: "included", deviceSurface: "absent", appClients: "included",
    relayConsumer: "included", relayAssociations: "included", nativeMcp: "absent", relayCustody: "not_exported_reapproval_required",
  });
  assert.deepEqual(prepared.counts.relayConsumer, { operations: { prepared: 1, committed: 1, acked: 0, blocked: 0, unknown: 1 }, issuers: 1, acknowledgements: { pending: 3, acked: 0 }, retainedAckRequests: 1 });
  assert.deepEqual(prepared.counts.relayAssociations, { associations: { active: 1, revoked: 1 }, history: 3, pins: 4, hostRevision: 2 });
  assert.deepEqual(prepared.counts.appClients.bindings, { active: 1, revoked: 1 });
  assert.deepEqual(prepared.counts.appClients.certificates, { active: 1, retired: 0, revoked: 1 });
  const id = prepared.checkpointId as string;
  // The offline open marked the crashed host's running work unknown; the checkpoint holds the source now.
  assert.deepEqual(readSourceAuthority(l.data).state, "checkpointed");
  const files = ["dexter.sqlite", "context.sqlite", "agenda.sqlite", "devices.sqlite", "app-clients.sqlite", "relay-host/relay-consumer.sqlite", "relay-host/relay-associations.sqlite"];
  const source = Object.fromEntries(files.map((file) => [file, tables(join(l.data, file))]));
  const sourceTree = Object.fromEntries(Object.entries(tree(join(l.data, "context-revisions"))).filter(([name]) => !name.startsWith(".git")));

  const revoked = okOut(await cliChild(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", id, "--destination", l.dest], l.custody));
  assert.deepEqual(revoked.authority, { installationId: seeded.hostId, epoch: 1, state: "revoked" });
  okOut(await cliChild(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", id, "--output", l.rcpt], l.custody));
  assert.equal(statSync(l.rcpt).mode & 0o777, 0o600);
  assert.ok(!readFileSync(l.rcpt, "utf8").includes(l.custody.wire.ownerPkcs8));
  const activated = okOut(await cliChild(["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt], l.custody));
  assert.equal(activated.epoch, 2); assert.equal(activated.resumed, false);
  assert.deepEqual(activated.hub, { epoch: 2, leaseRowsRemoved: 0, nativeCursorsCleared: 0, devicesRevoked: 2, actionsBlocked: 0 });
  assert.deepEqual({ offers: activated.registryOffersCancelled, claims: activated.registryClaimsClosed }, { offers: 2, claims: 1 });

  // Destination: every public store, row for row, except the documented activation effects.
  const dest = Object.fromEntries(files.map((file) => [file, tables(join(l.dest, file))]));
  const hubSrc = source["dexter.sqlite"]!; const hubDst = dest["dexter.sqlite"]!;
  for (const table of Object.keys(hubSrc)) {
    if (["devices", "events", "thread_sessions", "host_authority", "host_lease"].includes(table)) continue;
    assert.deepEqual(hubDst[table], hubSrc[table], `hub ${table} is exact`);
  }
  assert.deepEqual(hubDst.host_lease, []);
  assert.deepEqual(without(hubDst.devices!, "revoked_at"), without(hubSrc.devices!, "revoked_at"));
  assert.ok(parse(hubDst.devices!).every((device) => device.revoked_at !== null), "transport trust is never restored by the copy");
  assert.deepEqual(without(hubDst.thread_sessions!, "native_cursor", "updated_at"), without(hubSrc.thread_sessions!, "native_cursor", "updated_at"));
  assert.ok(parse(hubDst.thread_sessions!).every((session) => session.native_cursor === null));
  assert.ok(hubSrc.events!.every((event) => hubDst.events!.includes(event)), "history is kept");
  assert.deepEqual(parse(hubDst.events!.filter((event) => !hubSrc.events!.includes(event))).map((event) => event.kind), ["device.revoked", "device.revoked"]);
  const authority = parse(hubDst.host_authority!)[0];
  assert.deepEqual({ state: authority.state, epoch: authority.epoch, provenance: authority.provenance, directory: authority.directory }, { state: "active", epoch: 2, provenance: "activation", directory: l.dest });
  assert.equal(parse(hubSrc.host_authority!)[0].state, "checkpointed");
  for (const file of ["context.sqlite", "agenda.sqlite", "relay-host/relay-consumer.sqlite", "relay-host/relay-associations.sqlite"]) assert.deepEqual(dest[file], source[file], `${file} is exact`);
  const app = { src: source["app-clients.sqlite"]!, dst: dest["app-clients.sqlite"]! };
  for (const table of ["meta", "client_certs", "client_bindings"]) assert.deepEqual(app.dst[table], app.src[table], `app clients ${table} (pins, history, bindings) exact`);
  assert.deepEqual(parse(app.dst.offers!).map((offer) => offer.status).sort(), ["cancelled", "claimed", "claimed", "claimed"]);
  assert.deepEqual(parse(app.dst.claims!).map((claim) => claim.status).sort(), ["approved", "approved", "rejected"]);
  assert.deepEqual(parse(app.dst.client_bindings!).map((binding) => binding.status).sort(), ["active", "revoked"], "a revoked binding stays revoked");
  assert.deepEqual(parse(dest["devices.sqlite"]!.offers!).map((offer) => offer.status), ["cancelled"]);
  assert.deepEqual(Object.fromEntries(Object.entries(tree(join(l.dest, "context-revisions"))).filter(([name]) => !name.startsWith(".git"))), sourceTree);
  // Uncertain and pending work stays exactly as it was: nothing is re-run or redelivered.
  assert.deepEqual(rows(join(l.dest, "dexter.sqlite"), `SELECT state FROM actions WHERE id = '${seeded.runningActionId}'`), [{ state: "unknown" }]);
  assert.deepEqual(rows(join(l.dest, "dexter.sqlite"), `SELECT state FROM actions WHERE id = '${seeded.awaitingActionId}'`), [{ state: "awaiting_approval" }]);
  assert.deepEqual(rows(join(l.dest, "dexter.sqlite"), "SELECT client_request_id, state FROM turns ORDER BY client_request_id").map((row) => `${row.client_request_id}:${row.state}`),
    ["relay-request-1:queued", "turn-done:completed", "turn-queued:queued", "turn-running:unknown"]);
  assert.deepEqual(rows(join(l.dest, "relay-host/relay-consumer.sqlite"), "SELECT operation_id, state FROM operations ORDER BY operation_id").map((row) => `${row.operation_id}:${row.state}`),
    ["op-committed:committed", "op-prepared:prepared", "op-unknown:unknown"]);
  assert.deepEqual(rows(join(l.dest, "agenda.sqlite"), "SELECT state FROM occurrences"), [{ state: "prepared" }]);
  assert.ok(!existsSync(join(l.dest, ACTIVATION_MARKER_FILE)));

  // The destination runs (ContextHost validates its repository); the source never opens again, even after the
  // lease is gone, and its copies cannot either.
  const store = new HostStore({ dataDir: l.dest });
  try {
    const context = new ContextHost(store, new FixtureMemoryAdapter([])); context.close();
    assert.deepEqual({ epoch: store.authorityStatus().epoch, bot: store.getBot(seeded.botId).name }, { epoch: 2, bot: "Synthetic" });
    assert.equal(store.getTurn(seeded.queuedTurnId).state, "queued");
    assert.equal(store.getAction(seeded.runningActionId).state, "unknown");
    assert.equal((await openChild(l.dest)).code, "HostError:host_locked", "a second process cannot write the destination");
  } finally { store.close(); }
  assert.deepEqual(await openChild(l.data), { ok: false, code: "HostError:host_locked" });
  assert.deepEqual(okOut(await cliIn(["doctor", "--data-dir", l.data])).doctor.hub.authority, { state: "revoked", epoch: 1, provenance: "genesis", boundHere: true });
  cpSync(l.data, join(l.root, "source-copy"), { recursive: true });
  cpSync(l.dest, join(l.root, "destination-copy"), { recursive: true });
  assert.equal((await openChild(join(l.root, "source-copy"))).code, "HostError:host_locked");
  assert.equal((await openChild(join(l.root, "destination-copy"))).code, "HostError:host_locked", "a copied directory never becomes active");

  // Lost response: the same receipt only confirms; a new receipt for the checkpoint is never issued again.
  const again = okOut(await cliChild(["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt], l.custody));
  assert.deepEqual({ resumed: again.resumed, hub: again.hub, epoch: again.epoch }, { resumed: true, hub: "already_published", epoch: 2 });
  const reissue = await cliChild(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", id, "--output", join(l.root, "r2.json")], l.custody);
  assert.equal(reissue.out.error, "authority_unavailable");
  const status = coordinatorStatus(l);
  assert.deepEqual({ installations: status.installations, open: status.openCheckpoints, nonces: status.noncesConsumed }, {
    installations: [{ installationId: seeded.hostId, epoch: 2, state: "active" }], open: [], nonces: 1,
  });
});

test("crash windows are recovered only through the explicit flow (real SIGKILL in a separate process)", async (t) => {
  await t.test("after the source checkpoint: refused until an explicit abort moves it to the next epoch", async (t2) => {
    const l = lab(t2);
    const seeded = seedInstallation(l.data);
    okOut(await cliIn(["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId], l.custody));
    const crashed = await cliChild(["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art], l.custody, { crash: "after-checkpoint" });
    assert.equal(crashed.signal, "SIGKILL");
    assert.ok(!existsSync(l.art));
    assert.deepEqual(await openChild(l.data), { ok: false, code: "HostError:host_locked" });
    assert.ok(okOut(await cliIn(["doctor", "--data-dir", l.data])).doctor.issues.includes("authority_checkpointed"));
    const [open] = coordinatorStatus(l).openCheckpoints;
    assert.equal(open.state, "prepared");
    assert.equal((await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", open.checkpointId, "--output", l.rcpt], l.custody)).out.error, "authority_unavailable");
    const aborted = okOut(await cliIn(["transfer", "abort", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", open.checkpointId], l.custody));
    assert.deepEqual(aborted.authority, { installationId: seeded.hostId, epoch: 2, state: "active" });
    assert.deepEqual(await openChild(l.data), { ok: true, status: { epoch: 2, state: "active", provenance: "genesis" } });
    assert.deepEqual(coordinatorStatus(l).checkpoints, { aborted: 1 });
  });

  await t.test("after the persisted revocation: the coordinator catches up by an idempotent retry", async (t2) => {
    const l = lab(t2);
    const { checkpointId } = await initPrepared(l);
    const crashed = await cliChild(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody, { crash: "after-revoke" });
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(readSourceAuthority(l.data).state, "revoked");
    assert.equal(coordinatorStatus(l).openCheckpoints[0].state, "captured");
    assert.equal((await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody)).out.error, "authority_unavailable");
    assert.equal((await cliIn(["transfer", "abort", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId], l.custody)).out.error, "host_host_locked",
      "a revoked source can never be aborted back to active (the Hub refuses to reopen it)");
    okOut(await cliIn(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody));
    okOut(await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody));
    assert.equal(okOut(await cliIn(["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt], l.custody)).epoch, 2);
    assert.deepEqual(await openChild(l.data), { ok: false, code: "HostError:host_locked" });
  });

  for (const [crash, expectDestination] of [["after-consume", false], ["after-destination", true], ["before-activated-record", true]] as const) {
    await t.test(`activation ${crash}: only a retry with the same receipt completes it`, async (t2) => {
      const l = lab(t2);
      const { seeded, checkpointId } = await initPrepared(l);
      okOut(await cliIn(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody));
      okOut(await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody));
      const crashed = await cliChild(["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt], l.custody, { crash });
      assert.equal(crashed.signal, "SIGKILL");
      assert.equal(existsSync(l.dest), expectDestination);
      const status = coordinatorStatus(l);
      assert.deepEqual({ state: status.openCheckpoints[0]?.state, nonces: status.noncesConsumed }, { state: "activating", nonces: 1 });
      // The parent reservation exists from just before the destination is created until just after the commit point.
      assert.equal(existsSync(join(l.root, ".destination.dexter-activation")), crash === "after-destination");
      if (crash === "after-destination") {
        assert.deepEqual(readdirSync(l.dest), [ACTIVATION_MARKER_FILE]);
        assert.equal((await openChild(l.dest)).code, "HostError:host_locked", "no new installation is bootstrapped over a pending activation");
        assert.deepEqual(readdirSync(l.dest), [ACTIVATION_MARKER_FILE]);
        assert.ok(okOut(await cliIn(["doctor", "--data-dir", l.dest])).doctor.issues.includes("activation_pending"));
      }
      if (crash === "before-activated-record") {
        // Past the commit point the destination is the authority; the coordinator record lags until the retry.
        assert.deepEqual(await openChild(l.dest), { ok: true, status: { epoch: 2, state: "active", provenance: "activation" } });
      }
      // Any other receipt is refused; the same receipt resumes (the crashed attempt's process is gone).
      assert.equal((await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", join(l.root, "other.json")], l.custody)).out.error, "authority_unavailable");
      const resumed = okOut(await cliChild(["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt], l.custody));
      assert.deepEqual({ resumed: resumed.resumed, epoch: resumed.epoch }, { resumed: true, epoch: 2 });
      assert.equal(resumed.hub === "already_published", crash === "before-activated-record");
      assert.deepEqual(await openChild(l.dest), { ok: true, status: { epoch: 2, state: "active", provenance: "activation" } });
      assert.deepEqual(coordinatorStatus(l).installations, [{ installationId: seeded.hostId, epoch: 2, state: "active" }]);
      assert.deepEqual(await openChild(l.data), { ok: false, code: "HostError:host_locked" });
      // The killed attempt's private (0700) plaintext staging stays reserved in the coordinator (its process is gone)
      // until the explicit, bounded recovery removes exactly it; the completed retry left none of its own.
      const leftovers = readdirSync(l.root).filter((name) => name.startsWith(".destination.activation-stg_"));
      assert.equal(leftovers.length, 1);
      for (const name of leftovers) assert.equal(statSync(join(l.root, name)).mode & 0o777, 0o700);
      const [orphan] = coordinatorStatus(l).openStagings;
      assert.deepEqual({ purpose: orphan.purpose, created: orphan.created, alive: orphan.processAlive }, { purpose: "activation", created: true, alive: false });
      const recovered = okOut(await cliIn(["staging", "recover", "--coordinator", l.coord, "--staging", orphan.stagingId]));
      assert.equal(recovered.staging.outcome, "removed"); assert.ok(recovered.staging.entriesRemoved >= 8);
      assert.deepEqual(readdirSync(l.root).filter((name) => name.includes(".activation-") || name.endsWith(".dexter-activation")), []);
      assert.deepEqual(coordinatorStatus(l).openStagings, []);
      assert.equal(okOut(await cliIn(["staging", "recover", "--coordinator", l.coord, "--staging", orphan.stagingId])).staging.outcome, "already_removed");
    });
  }

  await t.test("a killed writer's stale lease never revives a revoked source", async (t2) => {
    const l = lab(t2);
    const { checkpointId } = await initPrepared(l);
    okOut(await cliIn(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody));
    okOut(await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody));
    okOut(await cliIn(["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt], l.custody));
    const holder = spawnChild("hold", { dataDir: l.dest });
    assert.equal((await holder.next()).ok, true);
    holder.child.send({ command: "die" });
    assert.equal((await holder.done).signal, "SIGKILL");
    assert.equal(liveRows(join(l.dest, "dexter.sqlite"), "SELECT COUNT(*) AS n FROM host_lease")[0].n, 1, "the dead writer's lease row remains");
    assert.deepEqual(await openChild(l.dest), { ok: true, status: { epoch: 2, state: "active", provenance: "activation" } }, "the active authority restarts");
    assert.deepEqual(await openChild(l.data), { ok: false, code: "HostError:host_locked" }, "the revoked source does not");
  });
});

test("activation receipts: binding, signature, owner, expiry, nonce and checkpoint state are enforced before anything is consumed", async (t) => {
  const l = lab(t);
  const { checkpointId } = await initPrepared(l);
  const other = { ...l, data: join(l.root, "other"), art: join(l.root, "other.dxg8") };
  const owner = rows(join(l.data, "dexter.sqlite"), "SELECT value FROM meta WHERE key = 'owner_id'")[0].value as string;
  seedInstallation(other.data, owner);
  const coordinator = AuthorityCoordinator.open(l.coord);
  t.after(() => coordinator.close());
  const at = { now: Date.now() };
  const controller = new LocalAuthorityController({ coordinator, clock: () => at.now });
  // A second installation of the same owner, prepared through the same coordinator: a different artifact.
  okOut(await cliIn(["transfer", "prepare", "--data-dir", other.data, "--coordinator", l.coord, "--output", other.art], l.custody));
  controller.revokeSource({ dataDir: l.data }, checkpointId, l.dest);
  const receipt = controller.issueReceipt(l.custody.owner, checkpointId, 60_000);
  const second = controller.issueReceipt(l.custody.owner, checkpointId, 60_000);
  const attempt = (r: ActivationReceipt, options: { artifact?: string; key?: TestCustody["key"]; now?: number } = {}) => () => {
    at.now = options.now ?? receipt.body.issuedAt + 1;
    return controller.activate({ artifact: options.artifact ?? l.art, key: options.key ?? l.custody.key, receipt: r });
  };
  const forged = (patch: Partial<ActivationReceipt["body"]>): ActivationReceipt => ({ body: { ...receipt.body, ...patch }, signature: receipt.signature });
  const foreign = generateKeyPairSync("ed25519").privateKey;
  const refusals: Array<[string, () => unknown, OperationsErrorCode]> = [
    ["another artifact", attempt(receipt, { artifact: other.art }), "authentication_failed"],
    ["another snapshot key", attempt(receipt, { key: newCustody().key }), "authentication_failed"],
    ["tampered destination", attempt(forged({ destination: join(l.root, "elsewhere") })), "authentication_failed"],
    ["tampered expiry", attempt(forged({ expiresAt: receipt.body.expiresAt + 3_600_000 })), "authentication_failed"],
    ["tampered epoch", attempt(forged({ sourceEpoch: 2 })), "authentication_failed"],
    ["extra field", attempt({ body: { ...receipt.body, grant: true } as unknown as ActivationReceipt["body"], signature: receipt.signature }), "authentication_failed"],
    ["foreign owner signature", attempt({ body: receipt.body, signature: sign(null, Buffer.from(`dexter.g8.activation-receipt\n${JSON.stringify(receipt.body)}`), foreign).toString("base64url") }), "authentication_failed"],
    ["foreign owner, canonical message", attempt(signActivationReceipt({ publicKey: l.custody.owner.publicKey, sign: (message) => sign(null, message, foreign) }, receipt.body)), "authentication_failed"],
    ["truncated signature", attempt({ body: receipt.body, signature: receipt.signature.slice(0, 40) }), "authentication_failed"],
    ["expired", attempt(receipt, { now: receipt.body.expiresAt }), "authentication_failed"],
    ["not yet valid", attempt(receipt, { now: receipt.body.issuedAt - 1 }), "authentication_failed"],
  ];
  for (const [label, run, expected] of refusals) {
    assert.throws(run, opCode(expected), label);
    assert.equal(coordinator.status().noncesConsumed, 0, `${label}: nothing consumed`);
    assert.ok(!existsSync(l.dest), `${label}: no destination`);
  }
  const activated = attempt(receipt)() as Json;
  assert.equal(activated.epoch, 2);
  assert.throws(attempt(second), opCode("authentication_failed"), "a second receipt for an activated checkpoint");
  assert.deepEqual((attempt(receipt)() as Json).hub, "already_published");
  assert.equal(coordinator.status().noncesConsumed, 1);

  // Backup = checkpoint + capture + abort: the artifact is pinned to a dead checkpoint at a stale epoch. Even a
  // receipt correctly signed by the owner for it is refused, and nothing is consumed.
  const third = { data: join(l.root, "third"), art: join(l.root, "third.dxg8") };
  seedInstallation(third.data, owner);
  const backup = okOut(await cliIn(["backup", "--data-dir", third.data, "--coordinator", l.coord, "--output", third.art], l.custody));
  assert.deepEqual({ resumedEpoch: backup.resumedEpoch, activatable: backup.activatable }, { resumedEpoch: 2, activatable: false });
  const record = coordinator.checkpoint(backup.checkpointId);
  assert.equal(record.state, "aborted");
  assert.throws(() => coordinator.receiptBody(backup.checkpointId, at.now, 60_000), opCode("authority_unavailable"));
  const body = { ...receipt.body, installationId: record.installationId, sourceEpoch: 1, checkpointId: backup.checkpointId, sourceDirectory: third.data,
    artifactSha256: record.artifactSha256!, manifestSha256: record.manifestSha256!, destination: join(l.root, "third-dest"), nonce: "e".repeat(64) };
  body.targetSha256 = coordinator.target(backup.checkpointId, body.destination);
  assert.throws(attempt(signActivationReceipt(l.custody.owner, body), { artifact: third.art }), opCode("authority_unavailable"));
  assert.equal(coordinator.status().noncesConsumed, 1);
  assert.equal(readSourceAuthority(third.data).epoch, 2);
});

/** Honest synthetic trusted host for the HostServices `quiesceForMaintenance()` contract, over real stores. */
class SyntheticHost implements MaintenanceQuiescePort {
  #stopped = false;
  readonly #inflight = new Set<Promise<void>>();
  #maintenance: Promise<MaintenanceStore> | undefined;
  constructor(readonly store: HostStore, readonly auxiliaries: Array<{ close(): void }>, readonly honest = true) {}
  admit(work: () => Promise<void>): void {
    if (this.#stopped) throw new Error("admission_stopped");
    const flight: Promise<void> = work().finally(() => this.#inflight.delete(flight));
    this.#inflight.add(flight);
  }
  quiesceForMaintenance(options: { graceMs?: number } = {}): Promise<MaintenanceStore> {
    this.#stopped = true; // synchronous, permanent, before the first await
    return this.#maintenance ??= (async () => {
      if (this.honest) {
        const drained = await Promise.race([Promise.all([...this.#inflight]).then(() => true), sleep(options.graceMs ?? 1_000).then(() => false)]);
        if (!drained) throw new Error("drain_incomplete");
        const failures: unknown[] = [];
        for (const auxiliary of this.auxiliaries) { try { auxiliary.close(); } catch (error) { failures.push(error); } }
        if (failures.length) throw new AggregateError(failures, "auxiliary_close_failed");
      }
      return this.store;
    })();
  }
}

test("online maintenance through the quiesce port: admission, real drain, auxiliaries, then the store fences", async (t) => {
  const setup = (t2: TestContext) => {
    const l = lab(t2);
    const store = new HostStore({ dataDir: l.data });
    const agenda = new Agenda(store); const clients = new ClientPairingRegistry(store); const devices = new DevicePairingRegistry(store);
    t2.after(() => { for (const close of [() => agenda.close(), () => clients.close(), () => devices.close(), () => store.close()]) { try { close(); } catch { /* already closed or fenced */ } } });
    const bot = store.createBot({ name: "Online", profileId: "personal", engine: "claude" });
    const thread = store.createThread(bot.id);
    store.setGrant({ botId: bot.id, tool: "fixture.run", destination: "dest_run", policy: "allow" });
    const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "fixture.run", destination: "dest_run", arguments: { n: 1 }, idempotencyKey: "online-1" });
    const coordinator = AuthorityCoordinator.open(l.coord, { ownerId: store.ownerId, ownerPublicKey: l.custody.owner.publicKey });
    t2.after(() => coordinator.close());
    return { l, store, agenda, clients, devices, action, coordinator, controller: new LocalAuthorityController({ coordinator }) };
  };

  await t.test("honest host: synchronous admission stop, in-flight effect drained, auxiliaries closed, revocation fences", async (t2) => {
    const { l, store, agenda, clients, devices, action, coordinator, controller } = setup(t2);
    const host = new SyntheticHost(store, [agenda, clients, devices]);
    host.admit(async () => { store.claimAction(action.id); await sleep(30); store.completeAction(action.id, { ok: true }); });
    const quiescing = controller.quiesce(host, 2_000);
    assert.throws(() => host.admit(async () => undefined), /admission_stopped/, "admission stopped before the first await");
    const hold = await quiescing;
    assert.equal(store.getAction(action.id).state, "succeeded", "the in-flight effect finished inside the drain");
    const prepared = controller.prepare(hold, { key: l.custody.key, output: l.art });
    assert.throws(() => store.createBot({ name: "late", profileId: "personal", engine: "claude" }), hostCode("host_locked"), "checkpoint closes the writer fence");
    controller.revokeSource({ store }, prepared.checkpointId, l.dest);
    assert.throws(() => store.withWriterLease(() => undefined), hostCode("host_locked"));
    store.close(); // final shutdown still releases the lease after revocation
    assert.throws(() => new HostStore({ dataDir: l.data }), hostCode("host_locked"));
    assert.equal(coordinator.checkpoint(prepared.checkpointId).state, "revoked");
  });

  await t.test("incomplete drain: quiesce rejects (cached), nothing is enrolled, checkpointed or captured", async (t2) => {
    const { l, store, agenda, clients, devices, action, coordinator, controller } = setup(t2);
    const host = new SyntheticHost(store, [agenda, clients, devices]);
    let release!: () => void;
    host.admit(async () => { store.claimAction(action.id); await new Promise<void>((done) => { release = done; }); store.completeAction(action.id, { ok: true }); });
    const first = controller.quiesce(host, 50);
    await assert.rejects(first, /drain_incomplete/);
    await assert.rejects(host.quiesceForMaintenance(), /drain_incomplete/, "the failure is cached");
    assert.deepEqual(coordinator.status().installations, []);
    assert.deepEqual({ state: store.authorityStatus().state, epoch: store.authorityStatus().epoch }, { state: "active", epoch: 1 });
    assert.ok(!existsSync(l.art));
    release(); await sleep(10);
    assert.equal(store.getAction(action.id).state, "succeeded");
  });

  await t.test("an auxiliary whose close fails: the rejection is cached and the writer is retained, never released early", async (t2) => {
    const { l, store, agenda, coordinator, controller } = setup(t2);
    const failing = { close: (): void => { throw new Error("synthetic close failure"); } };
    const host = new SyntheticHost(store, [agenda, failing]);
    await assert.rejects(controller.quiesce(host), /auxiliary_close_failed/);
    await assert.rejects(host.quiesceForMaintenance(), /auxiliary_close_failed/, "cached, no second cleanup attempt can confirm it");
    assert.equal(store.authorityStatus().state, "active");
    assert.equal((await openChild(l.data)).code, "HostError:host_locked", "the lease is still held by this writer");
    assert.deepEqual(coordinator.status().installations, []);
    assert.ok(!existsSync(l.art));
  });

  await t.test("a port that claims a drain it did not do cannot checkpoint: the store sees the running work", async (t2) => {
    const { l, store, action, coordinator, controller } = setup(t2);
    store.claimAction(action.id);
    const hold = await controller.quiesce(new SyntheticHost(store, [], false));
    assert.throws(() => controller.prepare(hold, { key: l.custody.key, output: l.art }), hostCode("conflict"));
    assert.deepEqual(coordinator.status().checkpoints, { aborted: 1 });
    assert.deepEqual({ state: store.authorityStatus().state, epoch: store.authorityStatus().epoch }, { state: "active", epoch: 1 });
    assert.ok(!existsSync(l.art));
  });

  await t.test("an auxiliary left open is fenced at the next write; abort reopens the fence at the next epoch", async (t2) => {
    const { l, store, agenda, clients, devices, action, controller } = setup(t2);
    store.claimAction(action.id); store.completeAction(action.id, { ok: true });
    const hold = await controller.quiesce(new SyntheticHost(store, [agenda, devices])); // forgets the app-client registry
    const prepared = controller.prepare(hold, { key: l.custody.key, output: l.art });
    assert.throws(() => clients.createOffer({ kind: "pair", role: "client-ios", scopes: ["chat.read"] }), "auxiliary writer refused by the checkpoint fence");
    const aborted = controller.abort({ store }, prepared.checkpointId);
    assert.deepEqual({ state: aborted.state, epoch: aborted.epoch }, { state: "active", epoch: 2 });
    assert.ok(clients.createOffer({ kind: "pair", role: "client-ios", scopes: ["chat.read"] }).offerId);
  });

  await t.test("a handle whose persisted epoch moved underneath it stops at its next fence", async (t2) => {
    const { store } = setup(t2);
    const raw = new DatabaseSync(store.databasePath);
    raw.exec("UPDATE host_authority SET epoch = epoch + 1"); raw.close();
    assert.throws(() => store.createBot({ name: "stale", profileId: "personal", engine: "claude" }), hostCode("host_locked"));
  });
});

test("legacy upgrade and rollback against the real old Hub code", async (t) => {
  // Needs a separate build of the unmodified Hub; the G8 lab recipe always provides it and requires zero skips.
  if (!BASE_HUB) { t.skip("G8_BASE_HUB_DIST (unmodified Root Hub build) is not provided"); return; }
  assert.ok(existsSync(BASE_HUB), "G8_BASE_HUB_DIST must point to the unmodified Root Hub build");
  const hubDist = pathToFileURL(BASE_HUB).href;
  const l = lab(t);
  const seed = (await (async () => { const s = spawnChild("old-seed", { dataDir: l.data, hubDist }); return (await s.done).messages[0]; })());
  assert.deepEqual({ ok: seed.ok, version: seed.schemaVersion }, { ok: true, version: 3 });
  const hub = join(l.data, "dexter.sqlite");
  const legacyHash = sha(readFileSync(hub));
  assert.equal((await openChild(l.data)).code, "HostError:conflict", "a legacy file never becomes a writer by being opened");
  assert.equal(sha(readFileSync(hub)), legacyHash, "refusal leaves the legacy file untouched");
  assert.ok(okOut(await cliIn(["doctor", "--data-dir", l.data])).doctor.issues.includes("legacy_upgrade_required"));
  const copy = join(l.root, "legacy-copy");
  cpSync(l.data, copy, { recursive: true });
  const ownerId = rows(hub, "SELECT value FROM meta WHERE key = 'owner_id'")[0].value as string;
  okOut(await cliIn(["coordinator", "init", "--coordinator", l.coord, "--owner-id", ownerId], l.custody));
  const upgraded = okOut(await cliChild(["upgrade", "--data-dir", l.data, "--coordinator", l.coord]));
  assert.deepEqual(upgraded.upgrade, { fromVersion: 3, toVersion: SCHEMA_VERSION, epoch: 1, provenance: "legacy_upgrade", resumed: false });
  assert.equal(okOut(await cliChild(["upgrade", "--data-dir", l.data, "--coordinator", l.coord])).upgrade.resumed, true, "lost response");
  // The same legacy installation elsewhere is refused by the coordinator before anything is written.
  const copyHash = sha(readFileSync(join(copy, "dexter.sqlite")));
  assert.equal((await cliChild(["upgrade", "--data-dir", copy, "--coordinator", l.coord])).out.error, "authority_unavailable");
  assert.equal(sha(readFileSync(join(copy, "dexter.sqlite"))), copyHash);
  // Data preserved; the new authority is bound to this directory.
  const store = new HostStore({ dataDir: l.data });
  try {
    assert.equal(store.listMessages(seed.threadId)[0]!.content, "synthetic legacy message");
    assert.deepEqual({ provenance: store.authorityStatus().provenance, epoch: store.authorityStatus().epoch }, { provenance: "legacy_upgrade", epoch: 1 });
  } finally { store.close(); }
  // Rollback: the old code refuses the current schema and changes nothing — it can never reopen an upgraded, checkpointed or
  // revoked installation.
  const upgradedHash = sha(readFileSync(hub));
  const oldOpen = (await spawnChild("old-open", { dataDir: l.data, hubDist }).done).messages[0];
  assert.deepEqual(oldOpen, { ok: false, code: "HostError:conflict" });
  assert.equal(sha(readFileSync(hub)), upgradedHash);
  okOut(await cliIn(["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art], l.custody));
  const checkpointed = sha(readFileSync(hub));
  assert.deepEqual((await spawnChild("old-open", { dataDir: l.data, hubDist }).done).messages[0], { ok: false, code: "HostError:conflict" });
  assert.equal(sha(readFileSync(hub)), checkpointed);
  // Documented incompatibility (not a guarantee): a stale pre-upgrade copy is still a schema-3 database that old code
  // opens as a writer. Rollback by restoring legacy copies is outside the authority model; no rollback path exists.
  assert.deepEqual((await spawnChild("old-open", { dataDir: copy, hubDist }).done).messages[0], { ok: true, schemaVersion: 3 });
});

test("checkpoint coverage is closed: unknown stores, drift and tampering fail; secrets are not in the artifact", async (t) => {
  for (const [label, mutate, expected] of [
    ["unknown store in the data directory", (data: string) => writeFileSync(join(data, "future.sqlite"), ""), "unsupported_component"],
    ["unknown store in relay-host", (data: string) => writeFileSync(join(data, "relay-host", "relay-writer.sqlite"), ""), "unsupported_component"],
    ["relay store outside relay-host", (data: string) => cpSync(join(data, "relay-host", "relay-consumer.sqlite"), join(data, "relay-consumer.sqlite")), "unsupported_component"],
    ["schema drift in the public associations", (data: string) => { const db = new DatabaseSync(join(data, "relay-host", "relay-associations.sqlite")); db.exec("CREATE INDEX extra ON pins(key_id)"); db.close(); }, "unsupported_schema"],
    ["omitted public column", (data: string) => { const db = new DatabaseSync(join(data, "relay-host", "relay-associations.sqlite")); db.exec("ALTER TABLE pins DROP COLUMN pin_json"); db.close(); }, "unsupported_schema"],
    ["broken relay history", (data: string) => { const db = new DatabaseSync(join(data, "relay-host", "relay-associations.sqlite")); db.exec("UPDATE associations SET status = 'active' WHERE device_id = 'dev_assoc_revoked'"); db.close(); }, "reference_broken"],
  ] as const) {
    await t.test(label, async (t2) => {
      const l = lab(t2);
      const seeded = seedInstallation(l.data);
      mutate(l.data);
      okOut(await cliIn(["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId], l.custody));
      const result = await cliIn(["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art], l.custody);
      assert.deepEqual(result.out, { ok: false, command: "transfer prepare", error: expected });
      assert.ok(!existsSync(l.art));
      assert.deepEqual(readdirSync(l.root).filter((name) => name.includes("checkpoint-")), [], "no staging left");
      // The failed capture was aborted: the source is active again at the next epoch.
      assert.deepEqual({ state: readSourceAuthority(l.data).state, epoch: readSourceAuthority(l.data).epoch }, { state: "active", epoch: 2 });
      assert.deepEqual(coordinatorStatus(l).checkpoints, { aborted: 1 });
    });
  }

  await t.test("tampering and key exclusion", async (t2) => {
    const l = lab(t2);
    await initPrepared(l);
    const opened = openCheckpointArtifact(l.art, l.custody.key);
    const plaintext = Buffer.concat([...opened.members.values()]);
    for (const secret of [LEASE_SENTINEL, l.custody.wire.secret, l.custody.wire.ownerPkcs8]) assert.ok(!plaintext.includes(secret), "no cursor or key material");
    const scratch = join(l.root, "hub-copy.sqlite"); writeFileSync(scratch, opened.members.get("hub.sqlite")!);
    assert.deepEqual(rows(scratch, "SELECT COUNT(*) AS n FROM host_lease"), [{ n: 0 }]);
    assert.deepEqual(rows(scratch, "SELECT COUNT(*) AS n FROM thread_sessions WHERE native_cursor IS NOT NULL"), [{ n: 0 }]);
    assert.ok(opened.manifest.excluded.byFormat.includes("Keychain, 1Password, OAuth and API tokens"));
    assert.equal(opened.manifest.coverage.relayCustody, "not_exported_reapproval_required");
    const bytes = readFileSync(l.art);
    const flipped = Buffer.from(bytes); flipped.writeUInt8(flipped.readUInt8(flipped.length - 30) ^ 0xff, flipped.length - 30);
    writeFileSync(join(l.root, "flipped.dxg8"), flipped);
    assert.throws(() => openCheckpointArtifact(join(l.root, "flipped.dxg8"), l.custody.key), opCode("authentication_failed"));
    assert.throws(() => openCheckpointArtifact(l.art, newCustody().key), opCode("authentication_failed"));
    const inspect = okOut(await cliIn(["artifact", "inspect", "--artifact", l.art], l.custody));
    assert.equal(inspect.activatable, "only_with_owner_receipt");
    assert.equal(inspect.artifactSha256, sha(bytes));
  });
});

test("inspection snapshots of a schema-4 Hub stay inspection-only and refuse the relay-host stores", async (t) => {
  const root = workspace(t);
  const custody = newCustody();
  const data = join(root, "data");
  const store = new HostStore({ dataDir: data });
  t.after(() => store.close());
  store.createThread(store.createBot({ name: "Inspect", profileId: "personal", engine: "claude" }).id);
  const include = { context: false, agenda: false, deviceRegistry: false, deviceSurface: false };
  const receipt = captureInspectionSnapshot({ source: store, include, key: custody.key, output: join(root, "inspect.dxg8") });
  assert.throws(() => openCheckpointArtifact(receipt.path, custody.key), opCode("corrupt"), "an inspection envelope is never a checkpoint artifact");
  restoreForInspection({ artifact: receipt.path, key: custody.key, destination: join(root, "inspection") });
  const hubCopy = join(root, "inspection", INSPECTION_DIR, INSPECTION_FILES.hub);
  assert.deepEqual(rows(hubCopy, "SELECT state FROM host_authority"), [{ state: "revoked" }]);
  const renamed = join(root, "renamed"); mkdirSync(renamed, { mode: 0o700 });
  cpSync(hubCopy, join(renamed, "dexter.sqlite"));
  assert.equal((await openChild(renamed)).code, "HostError:host_locked", "even renamed, an inspection copy never opens as a writer");
  writeRelayAssociations(join(data, "relay-host"), store.hostId, store.ownerId);
  assert.throws(() => captureInspectionSnapshot({ source: store, include, key: custody.key, output: join(root, "again.dxg8") }), opCode("unsupported_component"));
});

// ================================================================================================================
// R7: trusted catalog (M1), per-member quota (M2), staging ownership and reservation crash windows, destination
// runtime restart and the real HostServices maintenance composition with the approved relay R2 candidate.

const dist = (module: string): string => new URL(`../../packages/operations/dist/${module}`, import.meta.url).href;
const surfaceFiles = ["dexter.sqlite", "devices.sqlite", "device-tools.sqlite", "app-clients.sqlite"];
const stagingNames = (root: string): string[] => readdirSync(root).filter((name) => /\.(checkpoint|activation)-stg_/.test(name));

test("M1: the CLI carries the trusted operation catalog to prepare AND activate; a populated device surface transfers exactly", async (t) => {
  const l = lab(t);
  const seeded = seedInstallation(l.data);
  const surface = await seedDeviceSurface(l.data, seeded);
  okOut(await cliIn(["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId], l.custody));
  const prepareArgv = ["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art];

  // An embedding that passes an empty catalog is refused before any checkpoint: nothing moves.
  assert.deepEqual((await cliIn(prepareArgv, l.custody, undefined, [])).out, { ok: false, command: "transfer prepare", error: "invalid_input" });
  assert.deepEqual({ state: readSourceAuthority(l.data).state, epoch: readSourceAuthority(l.data).epoch }, { state: "active", epoch: 1 });
  assert.deepEqual(coordinatorStatus(l).checkpoints, {});
  // A catalog of an older release only does not cover the current pins: the capture refuses and is aborted cleanly.
  assert.equal((await cliIn(prepareArgv, l.custody, undefined, OLD_ONLY_CATALOG)).out.error, "reference_broken");
  assert.deepEqual({ state: readSourceAuthority(l.data).state, epoch: readSourceAuthority(l.data).epoch }, { state: "active", epoch: 2 });
  assert.deepEqual(stagingNames(l.root), []); assert.ok(!existsSync(l.art));
  assert.deepEqual(coordinatorStatus(l).openStagings, []);

  // The shipped default: this build's catalog, in a separate process.
  const prepared = okOut(await cliChild(prepareArgv, l.custody));
  assert.equal(prepared.coverage.deviceSurface, "included");
  const counts = prepared.counts.deviceSurface;
  assert.ok(counts, "surface counts recorded");
  const source = Object.fromEntries(surfaceFiles.map((file) => [file, tables(join(l.data, file))]));
  const id = prepared.checkpointId as string;
  okOut(await cliChild(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", id, "--destination", l.dest], l.custody));
  okOut(await cliChild(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", id, "--output", l.rcpt], l.custody));
  const activateArgv = ["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt];

  // Activation catalog problems are refused BEFORE the nonce: empty (before staging) and older-only (while validating
  // the staged copies, which are then removed). The source stays revoked; nothing is consumed or created.
  for (const [catalog, expected] of [[[], "invalid_input"], [OLD_ONLY_CATALOG, "reference_broken"]] as const) {
    assert.equal((await cliChild(activateArgv, l.custody, { catalog: catalog as unknown[] })).out.error, expected);
    const status = coordinatorStatus(l);
    assert.deepEqual({ nonces: status.noncesConsumed, state: status.openCheckpoints[0].state, stagings: status.openStagings }, { nonces: 0, state: "revoked", stagings: [] });
    assert.ok(!existsSync(l.dest)); assert.deepEqual(stagingNames(l.root), []);
    assert.equal(readSourceAuthority(l.data).state, "revoked");
  }
  const activated = okOut(await cliChild(activateArgv, l.custody));
  // Epoch 3: the source moved to epoch 2 when the older-catalog capture was aborted.
  assert.deepEqual({ epoch: activated.epoch, surface: activated.coverage.deviceSurface }, { epoch: 3, surface: "included" });
  assert.deepEqual(activated.counts.deviceSurface, counts);

  // Exact retained state: every surface table (routes, calls, request hashes, composite bindings, unknown and intent
  // calls, history) row for row; registry pins, certificates, bindings and late receipts exact.
  const dest = Object.fromEntries(surfaceFiles.map((file) => [file, tables(join(l.dest, file))]));
  assert.deepEqual(dest["device-tools.sqlite"], source["device-tools.sqlite"], "device surface is exact");
  for (const table of Object.keys(source["devices.sqlite"]!)) {
    if (table === "offers" || table === "claims") continue;
    assert.deepEqual(dest["devices.sqlite"]![table], source["devices.sqlite"]![table], `registry ${table} is exact`);
  }
  assert.ok(parse(dest["devices.sqlite"]!.offers!).every((offer) => offer.status !== "open"), "no copied one-time pairing stays open");
  assert.deepEqual(dest["dexter.sqlite"]!.grants, source["dexter.sqlite"]!.grants, "grants are neither added nor removed");
  assert.ok(parse(dest["dexter.sqlite"]!.devices!).every((device) => device.revoked_at !== null), "every Hub device (old pins included) is revoked at the destination");
  const surfaceRows = rows(join(l.dest, "device-tools.sqlite"), "SELECT name FROM sqlite_schema WHERE type = 'table'").map((row) => row.name);
  assert.ok(surfaceRows.length >= 3);
  assert.deepEqual(rows(join(l.dest, "dexter.sqlite"), `SELECT id, state FROM actions WHERE id IN ('${surface.okActionId}', '${surface.unknownActionId}') ORDER BY state`),
    [{ id: surface.okActionId, state: "succeeded" }, { id: surface.unknownActionId, state: "unknown" }]);
  // Re-pairing is an explicit new owner flow: the revoked device cannot be rotated back, a fresh offer can be made.
  const store = new HostStore({ dataDir: l.dest });
  try {
    const registry = new DevicePairingRegistry(store);
    try {
      assert.throws(() => registry.createOffer({ kind: "rotate", deviceId: surface.deviceId }));
      assert.ok(registry.createOffer({ kind: "pair" }).offerId);
    } finally { registry.close(); }
  } finally { store.close(); }
  assert.deepEqual(coordinatorStatus(l).openStagings, []);
});

test("M2: per-member database and Git quotas are enforced at decode, before any nonce, staging or publication", async (t) => {
  const l = lab(t);
  const { checkpointId } = await initPrepared(l);
  okOut(await cliIn(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody));
  okOut(await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody));
  const opened = openCheckpointArtifact(l.art, l.custody.key);
  const databases = opened.manifest.members.filter((member) => !member.name.startsWith("context-git/"));
  const git = opened.manifest.members.filter((member) => member.name.startsWith("context-git/"));
  const dbMax = Math.max(...databases.map((member) => member.bytes)); const gitMax = Math.max(...git.map((member) => member.bytes));
  assert.ok(dbMax > 1 && gitMax > 1 && git.length > 2);
  // Below / exactly / over the chosen quotas, on the genuine signed artifact (no giant fixture).
  assert.ok(openCheckpointArtifact(l.art, l.custody.key, { maxDatabaseBytes: dbMax }));
  assert.ok(openCheckpointArtifact(l.art, l.custody.key, { maxGitObjectBytes: gitMax }));
  assert.ok(openCheckpointArtifact(l.art, l.custody.key, { maxDatabaseBytes: dbMax + 1, maxGitObjectBytes: gitMax + 1 }));
  assert.throws(() => openCheckpointArtifact(l.art, l.custody.key, { maxDatabaseBytes: dbMax - 1 }), opCode("quota_exceeded"));
  assert.throws(() => openCheckpointArtifact(l.art, l.custody.key, { maxDatabaseBytes: 1 }), opCode("quota_exceeded"));
  assert.throws(() => openCheckpointArtifact(l.art, l.custody.key, { maxGitObjectBytes: gitMax - 1 }), opCode("quota_exceeded"));

  const coordinator = AuthorityCoordinator.open(l.coord);
  t.after(() => coordinator.close());
  const controller = new LocalAuthorityController({ coordinator });
  const receipt = JSON.parse(readFileSync(l.rcpt, "utf8")) as ActivationReceipt;
  const sourceHub = sha(readFileSync(join(l.data, "dexter.sqlite")));
  for (const limits of [{ maxDatabaseBytes: dbMax - 1 }, { maxDatabaseBytes: 1 }, { maxGitObjectBytes: gitMax - 1 }]) {
    assert.throws(() => controller.activate({ artifact: l.art, key: l.custody.key, receipt, limits }), opCode("quota_exceeded"), JSON.stringify(limits));
    const status = coordinator.status();
    assert.deepEqual({ nonces: status.noncesConsumed, open: status.openCheckpoints.map((c) => c.state), installations: status.installations.map((i) => `${i.epoch}:${i.state}`), stagings: status.openStagings },
      { nonces: 0, open: ["revoked"], installations: ["1:transferring"], stagings: [] });
    assert.ok(!existsSync(l.dest)); assert.deepEqual(stagingNames(l.root), []);
    assert.ok(!existsSync(join(l.root, ".destination.dexter-activation")));
    assert.deepEqual({ state: readSourceAuthority(l.data).state, epoch: readSourceAuthority(l.data).epoch }, { state: "revoked", epoch: 1 });
    assert.equal(sha(readFileSync(join(l.data, "dexter.sqlite"))), sourceHub, "prior writer unchanged");
  }
  // The explicit operator retry with a sufficient limit (exactly the largest member) completes.
  const done = controller.activate({ artifact: l.art, key: l.custody.key, receipt, limits: { maxDatabaseBytes: dbMax, maxGitObjectBytes: gitMax } });
  assert.deepEqual({ epoch: done.epoch, resumed: done.resumed }, { epoch: 2, resumed: false });

  // Forged manifests (decoder on the exact built module): negative, overflow, fractional, duplicate, unsupported,
  // too many members, aggregate beyond the artifact limit.
  const { decodeCheckpointManifest } = await import(dist("checkpoint.js")) as { decodeCheckpointManifest(value: unknown, limits: unknown): unknown };
  const { resolveLimits } = await import(dist("manifest.js")) as { resolveLimits(value: unknown): Record<string, number> };
  const base = JSON.parse(JSON.stringify(opened.manifest)) as Json;
  const decode = (mutate: (m: Json) => void, limits: Json = {}) => () => { const m = JSON.parse(JSON.stringify(base)); mutate(m); return decodeCheckpointManifest(m, resolveLimits(limits)); };
  assert.ok(decode(() => undefined)());
  const hubIndex = base.members.findIndex((member: Json) => member.name === "hub.sqlite");
  const total = base.members.reduce((sum: number, member: Json) => sum + member.bytes, 0);
  for (const [label, run, expected] of [
    ["negative", decode((m) => { m.members[hubIndex].bytes = -1; }), "corrupt"],
    ["overflow", decode((m) => { m.members[hubIndex].bytes = 2 ** 53; }), "corrupt"],
    ["fractional", decode((m) => { m.members[hubIndex].bytes = 1.5; }), "corrupt"],
    ["duplicate", decode((m) => { m.members.push({ ...m.members[hubIndex] }); }), "corrupt"],
    ["unsupported member", decode((m) => { m.members.push({ name: "context-git/config", bytes: 1, sha256: "0".repeat(64) }); }), "corrupt"],
    ["database over quota", decode(() => undefined, { maxDatabaseBytes: dbMax - 1 }), "quota_exceeded"],
    ["git over quota", decode(() => undefined, { maxGitObjectBytes: gitMax - 1 }), "quota_exceeded"],
    ["too many members", decode(() => undefined, { maxMembers: base.members.length - 1 }), "quota_exceeded"],
    ["aggregate", decode(() => undefined, { maxArtifactBytes: total - 1 }), "quota_exceeded"],
  ] as const) assert.throws(run, opCode(expected), label);
});

test("crash recovery: plaintext staging is owned through the coordinator and recovered only explicitly and safely", async (t) => {
  await t.test("capture killed inside the fence: bounded recovery, with symlink, inode swap and live-attempt refusals", async (t2) => {
    const l = lab(t2);
    const seeded = seedInstallation(l.data);
    okOut(await cliIn(["coordinator", "init", "--coordinator", l.coord, "--owner-id", seeded.ownerId], l.custody));
    const crashed = await cliChild(["transfer", "prepare", "--data-dir", l.data, "--coordinator", l.coord, "--output", l.art], l.custody, { crash: "after-capture-fence" });
    assert.equal(crashed.signal, "SIGKILL");
    assert.ok(!existsSync(l.art));
    const [orphan] = coordinatorStatus(l).openStagings;
    assert.deepEqual({ purpose: orphan.purpose, created: orphan.created, alive: orphan.processAlive }, { purpose: "capture", created: true, alive: false });
    const [name] = stagingNames(l.root);
    const staging = join(l.root, name!);
    const files = readdirSync(staging);
    assert.ok(files.includes("hub.sqlite") && files.length >= 7, "the crash left plaintext copies (the documented risk)");
    assert.equal(statSync(staging).mode & 0o777, 0o700);
    const recover = (stagingId: string) => cliIn(["staging", "recover", "--coordinator", l.coord, "--staging", stagingId]);
    assert.equal((await recover("stg_" + "A".repeat(24))).out.error, "authority_unavailable");
    assert.equal((await recover("not-a-staging")).out.error, "invalid_input");
    // A symlink planted inside: refused before the first removal.
    const { symlinkSync, renameSync, unlinkSync } = await import("node:fs");
    symlinkSync(join(l.data, "dexter.sqlite"), join(staging, "planted"));
    assert.equal((await recover(orphan.stagingId)).out.error, "unsafe_path");
    assert.deepEqual(readdirSync(staging).sort(), [...files, "planted"].sort());
    assert.ok(existsSync(join(l.data, "dexter.sqlite")), "the symlink target is untouched");
    unlinkSync(join(staging, "planted"));
    // Swapped directory under the reserved name: refused (inode mismatch), nothing removed.
    renameSync(staging, join(l.root, "moved-staging"));
    mkdirSync(staging, { mode: 0o700 }); writeFileSync(join(staging, "foreign"), "x");
    assert.equal((await recover(orphan.stagingId)).out.error, "identity_mismatch");
    assert.ok(existsSync(join(staging, "foreign")));
    rmSync(staging, { recursive: true }); renameSync(join(l.root, "moved-staging"), staging);
    // A staging reserved by a live process (this one) is never recovered.
    const coordinator = AuthorityCoordinator.open(l.coord);
    try {
      const live = coordinator.reserveStaging(orphan.checkpointId, "capture", l.root, "live.dxg8", null, Date.now());
      assert.equal((await recover(live.stagingId)).out.error, "destination_exists");
    } finally { coordinator.close(); }
    const recovered = okOut(await recover(orphan.stagingId));
    assert.deepEqual({ outcome: recovered.staging.outcome, removed: recovered.staging.entriesRemoved }, { outcome: "removed", removed: files.length + 1 });
    assert.ok(!existsSync(staging));
    assert.ok(existsSync(join(l.data, "dexter.sqlite")));
    // The checkpoint itself is still recovered only by the explicit abort (source back at the next epoch).
    const aborted = okOut(await cliIn(["transfer", "abort", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", orphan.checkpointId], l.custody));
    assert.deepEqual(aborted.authority.epoch, 2);
  });

  await t.test("activation killed after its staging was created: the nonce is untouched and a plain retry activates", async (t2) => {
    const l = lab(t2);
    const { checkpointId } = await initPrepared(l);
    okOut(await cliIn(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody));
    okOut(await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody));
    const argv = ["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt];
    assert.equal((await cliChild(argv, l.custody, { crash: "after-staging-created" })).signal, "SIGKILL");
    const status = coordinatorStatus(l);
    assert.deepEqual({ nonces: status.noncesConsumed, state: status.openCheckpoints[0].state, stagings: status.openStagings.length }, { nonces: 0, state: "revoked", stagings: 1 });
    assert.ok(!existsSync(l.dest));
    const done = okOut(await cliChild(argv, l.custody));
    assert.deepEqual({ epoch: done.epoch, resumed: done.resumed }, { epoch: 2, resumed: false });
    const [orphan] = coordinatorStatus(l).openStagings;
    assert.equal(okOut(await cliIn(["staging", "recover", "--coordinator", l.coord, "--staging", orphan.stagingId])).staging.outcome, "removed");
    assert.deepEqual(stagingNames(l.root), []);
  });

  for (const crash of ["before-destination-mkdir", "after-destination-mkdir"] as const) {
    await t.test(`destination reservation window (${crash}): no genesis can take the directory; the same receipt resumes`, async (t2) => {
      const l = lab(t2);
      const { checkpointId } = await initPrepared(l);
      okOut(await cliIn(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody));
      okOut(await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody));
      const argv = ["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt];
      assert.equal((await cliChild(argv, l.custody, { crash, destination: l.dest })).signal, "SIGKILL");
      assert.ok(existsSync(join(l.root, ".destination.dexter-activation")));
      assert.equal(existsSync(l.dest), crash === "after-destination-mkdir");
      if (existsSync(l.dest)) assert.deepEqual(readdirSync(l.dest), [], "the window: an empty, unmarked directory");
      assert.equal(coordinatorStatus(l).noncesConsumed, 1);
      assert.deepEqual(await openChild(l.dest), { ok: false, code: "HostError:host_locked" }, "a fresh store never bootstraps a reserved destination");
      assert.equal(existsSync(l.dest), crash === "after-destination-mkdir", "the refused open did not create the directory");
      assert.ok(okOut(await cliIn(["doctor", "--data-dir", l.dest])).doctor.issues.includes("activation_reserved"));
      const resumed = okOut(await cliChild(argv, l.custody));
      assert.deepEqual({ epoch: resumed.epoch, resumed: resumed.resumed }, { epoch: 2, resumed: true });
      assert.ok(!existsSync(join(l.root, ".destination.dexter-activation")) && !existsSync(join(l.dest, ACTIVATION_MARKER_FILE)));
      assert.deepEqual(await openChild(l.dest), { ok: true, status: { epoch: 2, state: "active", provenance: "activation" } });
      assert.deepEqual(await openChild(l.data), { ok: false, code: "HostError:host_locked" });
      for (const orphan of coordinatorStatus(l).openStagings) okOut(await cliIn(["staging", "recover", "--coordinator", l.coord, "--staging", orphan.stagingId]));
      assert.deepEqual(stagingNames(l.root), []);
    });
  }
});

test("destination restart with the real HostServices runtime: queued work held, unknown kept, no second kick", async (t) => {
  const l = lab(t);
  const { seeded, checkpointId } = await initPrepared(l);
  okOut(await cliIn(["transfer", "revoke", "--data-dir", l.data, "--coordinator", l.coord, "--checkpoint", checkpointId, "--destination", l.dest], l.custody));
  okOut(await cliIn(["transfer", "receipt", "--coordinator", l.coord, "--checkpoint", checkpointId, "--output", l.rcpt], l.custody));
  okOut(await cliIn(["transfer", "activate", "--coordinator", l.coord, "--artifact", l.art, "--receipt", l.rcpt], l.custody));
  const relayBefore = tables(join(l.dest, "relay-host/relay-consumer.sqlite"));
  const report = (await spawnChild("services", { dataDir: l.dest, heldThreadId: seeded.threadId, botId: seeded.botId }).done).messages[0];
  assert.deepEqual(report, {
    ok: true, epoch: 2, provenance: "activation", opensBefore: 0, turnsBefore: 0, queued: ["relay-request-1", "turn-queued"], unknownTurns: ["turn-running"],
    heldThread: "HostError:conflict", turnsAfter: 1, freshState: "completed",
  });
  assert.deepEqual(rows(join(l.dest, "dexter.sqlite"), `SELECT state FROM actions WHERE id = '${seeded.runningActionId}'`), [{ state: "unknown" }]);
  assert.deepEqual(rows(join(l.dest, "dexter.sqlite"), `SELECT state FROM actions WHERE id = '${seeded.awaitingActionId}'`), [{ state: "awaiting_approval" }]);
  assert.deepEqual(rows(join(l.dest, "agenda.sqlite"), "SELECT state FROM occurrences"), [{ state: "prepared" }]);
  assert.deepEqual(tables(join(l.dest, "relay-host/relay-consumer.sqlite")), relayBefore, "relay journal untouched: nothing redelivered");
  assert.deepEqual((await spawnChild("services", { dataDir: l.data, heldThreadId: seeded.threadId, botId: seeded.botId }).done).messages[0],
    { ok: false, code: "HostError:host_locked" }, "the revoked source never restarts");
});

test("real HostServices composition (approved relay R2): quiesceForMaintenance drains, lends the same writer, checkpoint/revoke, final shutdown", async (t) => {
  const l = lab(t);
  const seed = new HostStore({ dataDir: l.data });
  const identity = { installationId: seed.hostId, ownerId: seed.ownerId, deviceId: "relay_host", generation: 1, keyId: "host_key" };
  seed.close();
  const custody = memoryCustody(identity);
  let transportCloses = 0;
  const transport: RelayTransport = { async poll() { return { deliveries: [], cursor: 0 }; }, async ack() { throw new Error("unexpected ack"); }, async close() { transportCloses += 1; } };
  const relay: RelayHostOptions = { recipient: custody.pin, custody: custody.provider, custodyMode: "laboratory-memory", transport, transportOwnership: "owned", deployment: { maximumPendingPerRecipient: 131 } };
  const held = gate(); let turns = 0; let streamEnded = false;
  const makeDriver = (engine: EngineId): EngineDriver => ({
    id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
    async status() { return { engine, installed: true, version: "synthetic", authentication: "authenticated", billing: "subscription" }; },
    async open(threadId: string, cursor?: string) { return { threadId, nativeCursor: cursor ?? "synthetic" }; },
    async *turn(session: { threadId: string }, turnId: string) {
      turns += 1;
      try { await held.promise; yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; } finally { streamEnded = true; }
    },
    async close() {}, async interrupt() {}, async respondToTool() {},
  });
  const services = new HostServices({ dataDir: l.data, enableEngines: true, enableAgenda: true, appClients: { identity: memoryTLS() }, relay, makeDriver });
  let shut = false;
  t.after(async () => { if (!shut) { held.resolve(); try { await services.shutdown({ graceMs: 2_000 }); } catch { /* quarantined */ } } });
  const store = services.store;
  const bot = store.createBot({ name: "Composed", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  services.runtime!.startTurn(thread.id, { clientRequestId: "inflight-1", content: "synthetic in flight" });
  for (let i = 0; i < 200 && turns === 0; i++) await sleep(5);
  assert.equal(turns, 1, "a turn is in flight inside the synthetic driver");

  const coordinator = AuthorityCoordinator.open(l.coord, { ownerId: store.ownerId, ownerPublicKey: l.custody.owner.publicKey });
  t.after(() => coordinator.close());
  const controller = new LocalAuthorityController({ coordinator });
  const quiescing = controller.quiesce(services, 5_000);
  // Admission stopped synchronously (before the first await): no new turn, no relay wake.
  assert.throws(() => services.runtime!.startTurn(store.createThread(bot.id).id, { clientRequestId: "late", content: "late" }));
  await assert.rejects(services.wakeRelay());
  let settled = false; void quiescing.then(() => { settled = true; }, () => { settled = true; });
  await sleep(50);
  assert.equal(settled, false, "the writer is not lent while the turn is still in flight");
  held.resolve();
  const hold = await quiescing;
  assert.equal(hold.store, store, "the SAME open writer-fenced store is lent");
  // The runtime drain aborts in-flight turns and waits for their streams: the effect ended before the lend.
  assert.equal(streamEnded, true, "the in-flight engine stream ended inside the drain");
  assert.deepEqual(store.listTurnsByState("running"), [], "nothing is left running when the writer is lent");
  assert.equal((await openChild(l.data)).code, "HostError:host_locked", "the lease is still held by the host process");

  const prepared = controller.prepare(hold, { key: l.custody.key, output: l.art, operationCatalog: CURRENT_CATALOG });
  assert.deepEqual({ relayConsumer: prepared.artifact.coverage.relayConsumer, relayAssociations: prepared.artifact.coverage.relayAssociations, appClients: prepared.artifact.coverage.appClients, agenda: prepared.artifact.coverage.agenda },
    { relayConsumer: "included", relayAssociations: "included", appClients: "included", agenda: "included" }, "the real relay-host stores are adopted");
  const relaySource = ["relay-host/relay-consumer.sqlite", "relay-host/relay-associations.sqlite"].map((file) => tables(join(l.data, file)));
  controller.revokeSource({ store: hold.store }, prepared.checkpointId, l.dest);
  assert.throws(() => store.withWriterLease(() => undefined), hostCode("host_locked"));
  // Final, caller-serialized shutdown still releases the lease after the revocation.
  await services.shutdown({ graceMs: 2_000 }); shut = true;
  assert.equal(transportCloses, 1);
  assert.deepEqual(await openChild(l.data), { ok: false, code: "HostError:host_locked" }, "revoked: never reopens even with the lease gone");

  const receipt = controller.issueReceipt(l.custody.owner, prepared.checkpointId);
  const activated = controller.activate({ artifact: l.art, key: l.custody.key, receipt, operationCatalog: CURRENT_CATALOG });
  assert.equal(activated.epoch, 2);
  assert.deepEqual(["relay-host/relay-consumer.sqlite", "relay-host/relay-associations.sqlite"].map((file) => tables(join(l.dest, file))), relaySource, "relay stores exact");

  // Relay custody is not part of the artifact: a destination host with a NEW custody pin is refused by relay-host
  // itself (explicit owner reapproval is required) and releases the writer; without relay it runs normally.
  const associations = tables(join(l.dest, "relay-host/relay-associations.sqlite"));
  const fresh = memoryCustody(identity);
  assert.throws(() => new HostServices({ dataDir: l.dest, enableEngines: true, appClients: { identity: memoryTLS() }, relay: { ...relay, recipient: fresh.pin, custody: fresh.provider }, makeDriver }));
  // relay-host switches the file to WAL on open (a header change); its rows, pins, tombstones and history are unchanged.
  assert.deepEqual(tables(join(l.dest, "relay-host/relay-associations.sqlite")), associations);
  assert.equal(fresh.closes, 0);
  const plain = new HostServices({ dataDir: l.dest, enableEngines: true, enableAgenda: true, appClients: { identity: memoryTLS() }, makeDriver });
  assert.equal(plain.store.authorityStatus().epoch, 2);
  await plain.shutdown({ graceMs: 2_000 });
  assert.deepEqual(await openChild(l.dest), { ok: true, status: { epoch: 2, state: "active", provenance: "activation" } });
});
