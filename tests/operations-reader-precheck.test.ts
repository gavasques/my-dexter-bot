import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HostStore, SCHEMA_VERSION } from "@dexter/hub";
import type { EngineDriver } from "@dexter/engines";
import type { EngineId } from "@dexter/contracts";
import type { RelayTransport } from "@dexter/relay-consumer";
import { OperationsError, doctor, readHubIdentity, readSourceAuthority } from "@dexter/operations";
import { planHostStartup, type HostStartupInput } from "../packages/cli/src/host-startup.js";
import { memoryCustody, memoryTLS } from "./fixtures/relay-host-lab.js";

// Synthetic only: private temporary directories, laboratory-labelled custody, fixture engines, no network or key files.
const dirOf = (t: TestContext, prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
};
const driver = (id: EngineId): EngineDriver => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
  async status() { return { engine: id, installed: true, version: "fixture", authentication: "authenticated", billing: "subscription" }; },
  async open(threadId) { return { threadId, nativeCursor: "synthetic" }; },
  async *turn(session, turnId) { yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
  async respondToTool() {}, async interrupt() {}, async close() {} });
/** Every entry under `root` with type, mode and content hash: byte-level before/after evidence, sidecars included. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (path: string, rel: string) => {
    const s = lstatSync(path);
    out.push(`${rel}|${s.isDirectory() ? "d" : s.isFile() ? "f" : "o"}|${(s.mode & 0o777).toString(8)}|${s.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : ""}`);
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), `${rel}/${name}`);
  };
  walk(root, ".");
  return out;
}
const entryOf = (root: string, name: string) => tree(root).find(line => line.startsWith(`./${name}|`));
/** Initialized canonical store (identity minted by the store itself), writer released. */
function seeded(data: string) {
  const store = new HostStore({ dataDir: data }), identity = { installationId: store.hostId, ownerId: store.ownerId };
  store.close(); return identity;
}
/** Another process commits with autocheckpoint off and is then SIGKILLed: a genuine committed orphan WAL+SHM pair. */
async function orphanCommit(t: TestContext, data: string, sql: string): Promise<void> {
  const script = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1] + "/dexter.sqlite");
db.exec(${JSON.stringify(`PRAGMA wal_autocheckpoint = 0; ${sql}`)}); process.stdout.write("committed\\n"); setInterval(() => {}, 10_000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, data], { stdio: ["ignore", "pipe", "inherit"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() } });
  const exited = new Promise(r => child.once("exit", r));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise<void>((done, fail) => { child.stdout.once("data", () => done()); child.once("error", fail); void exited.then(() => fail(new Error("exited before commit"))); });
  child.kill("SIGKILL"); await exited;
}
const COMMIT_EPOCH = "UPDATE host_authority SET epoch = epoch + 1 WHERE id = 1;";
function relayFixture(identity: { installationId: string; ownerId: string }) {
  const custody = memoryCustody({ ...identity, deviceId: "relay_host", generation: 1, keyId: "host_key" });
  let polls = 0, closes = 0;
  const transport: RelayTransport = { async poll() { polls++; return { deliveries: [], cursor: 0 }; }, async ack() { throw Error("unexpected ack"); }, async close() { closes++; } };
  const next = memoryCustody({ ...identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
  const input = (data: string, route: "relay" | "recovery"): HostStartupInput => (route === "relay"
    ? { route: "laboratory", options: { dataDir: data, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } },
      providers: { relay: { recipient: custody.pin, custody: custody.provider, custodyMode: "laboratory-memory", transport, transportOwnership: "owned",
        deployment: { maximumPendingPerRecipient: 16 } } }, makeDriver: driver }
    : { route: "laboratory", options: { dataDir: data, enableRelayRecovery: true, appClients: { identity: memoryTLS() } },
      providers: { relayRecovery: { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" } } } });
  const untouched = () => custody.closes === 0 && !custody.signStarted && next.closes === 0 && !next.signStarted && polls === 0 && closes === 0;
  return { input, untouched };
}
const corrupt = (error: unknown) => error instanceof OperationsError && error.code === "corrupt";

test("plan, identity readers and doctor refuse a known-empty or truncated main before any SQLite read, so a WAL beside it survives", async t => {
  const dir = dirOf(t, "dx-reader-truncated-");
  const layouts: [string, "pair" | "incomplete", (data: string) => void][] = [
    ["zero-byte main beside a committed WAL/-shm pair", "pair", data => truncateSync(join(data, "dexter.sqlite"), 0)],
    ["zero-byte main beside a committed lone WAL", "incomplete", data => { truncateSync(join(data, "dexter.sqlite"), 0); unlinkSync(join(data, "dexter.sqlite-shm")); }],
    ["main shorter than 512 bytes beside a committed pair", "pair", data => truncateSync(join(data, "dexter.sqlite"), 100)],
    ["main not a multiple of 512 bytes beside a committed pair", "pair", data => truncateSync(join(data, "dexter.sqlite"), lstatSync(join(data, "dexter.sqlite")).size - 100)],
  ];
  for (const [name, sidecars, damage] of layouts) {
    const data = join(dir, name.replace(/[^a-z0-9]+/gi, "-")), identity = seeded(data), fixture = relayFixture(identity);
    await orphanCommit(t, data, COMMIT_EPOCH);
    assert.ok(lstatSync(join(data, "dexter.sqlite-wal")).size > 0, `${name}: genuine committed WAL`);
    damage(data);
    const before = tree(data);
    for (const route of ["relay", "recovery"] as const) {
      assert.throws(() => planHostStartup(fixture.input(data, route)), /initialized canonical store/, `${name} (${route})`);
      assert.deepEqual(tree(data), before, `${name} (${route}): main, WAL and -shm byte-identical`);
    }
    assert.throws(() => readHubIdentity(data), corrupt, name);
    assert.throws(() => readSourceAuthority(data), corrupt, name);
    const report = doctor(data);
    assert.equal(report.ok, false, name);
    assert.ok(report.issues.includes("hub_truncated"), `${name}: ${report.issues.join(",")}`);
    assert.deepEqual({ file: report.hub.file, sidecars: report.hub.sidecars, schemaVersion: report.hub.schemaVersion, authority: report.hub.authority },
      { file: "present", sidecars, schemaVersion: null, authority: null }, name);
    assert.deepEqual(tree(data), before, `${name}: every reader left the tree byte-identical, WAL included`);
    assert.equal(existsSync(join(data, "relay-host")), false, name);
    assert.ok(fixture.untouched(), `${name}: no custody or transport effect`);
  }
  // A zero-byte component database beside a sidecar pair is reported without being opened.
  const data = join(dir, "component"); seeded(data);
  writeFileSync(join(data, "context.sqlite"), ""); writeFileSync(join(data, "context.sqlite-wal"), Buffer.alloc(4152, 0x5a)); writeFileSync(join(data, "context.sqlite-shm"), Buffer.alloc(32768));
  const before = tree(data), report = doctor(data);
  assert.deepEqual(report.components.context, { sidecars: "pair", schema: "not_opened" });
  assert.ok(report.issues.includes("context_truncated"), report.issues.join(","));
  assert.deepEqual(tree(data), before, "component WAL and -shm byte-identical");
});

test("the precheck keeps read-only reads of closed, committed-orphan and live-writer databases working", async t => {
  const dir = dirOf(t, "dx-reader-valid-");
  // Closed store: immutable reads, nothing created; the plan accepts the matching identity.
  const closed = join(dir, "closed"), identity = seeded(closed), fixture = relayFixture(identity), before = tree(closed);
  assert.deepEqual(readHubIdentity(closed), { schemaVersion: SCHEMA_VERSION, ...identity });
  assert.equal(readSourceAuthority(closed).state, "active");
  const report = doctor(closed);
  assert.equal(report.ok, true, report.issues.join(","));
  for (const route of ["relay", "recovery"] as const) planHostStartup(fixture.input(closed, route));
  assert.ok(fixture.untouched());
  assert.deepEqual(tree(closed), before, "closed store unchanged by every reader");

  // Committed orphan pair beside a valid main: the read-only readers see the WAL-resident commit and cannot consume it.
  const orphan = join(dir, "orphan"), orphanIdentity = seeded(orphan), orphanFixture = relayFixture(orphanIdentity);
  await orphanCommit(t, orphan, COMMIT_EPOCH);
  const main = entryOf(orphan, "dexter.sqlite"), wal = entryOf(orphan, "dexter.sqlite-wal");
  assert.ok(wal && lstatSync(join(orphan, "dexter.sqlite-wal")).size > 0);
  assert.deepEqual(readHubIdentity(orphan), { schemaVersion: SCHEMA_VERSION, ...orphanIdentity });
  assert.deepEqual({ state: readSourceAuthority(orphan).state, epoch: readSourceAuthority(orphan).epoch }, { state: "active", epoch: 2 });
  const orphanReport = doctor(orphan);
  assert.equal(orphanReport.ok, true, orphanReport.issues.join(","));
  assert.deepEqual(orphanReport.hub.authority, { state: "active", epoch: 2, provenance: "genesis", boundHere: true });
  for (const route of ["relay", "recovery"] as const) planHostStartup(orphanFixture.input(orphan, route));
  assert.equal(entryOf(orphan, "dexter.sqlite"), main, "main byte-identical");
  assert.equal(entryOf(orphan, "dexter.sqlite-wal"), wal, "committed WAL byte-identical");
  assert.ok(existsSync(join(orphan, "dexter.sqlite-shm")), "-shm (rebuildable wal-index) still present");
  assert.ok(orphanFixture.untouched());

  // Live writer in this process: the readers run beside it and the plan accepts; the writer keeps working afterwards.
  const live = join(dir, "live"), store = new HostStore({ dataDir: live }), liveIdentity = { installationId: store.hostId, ownerId: store.ownerId };
  try {
    assert.ok(existsSync(join(live, "dexter.sqlite-wal")), "live WAL pair");
    assert.deepEqual(readHubIdentity(live), { schemaVersion: SCHEMA_VERSION, ...liveIdentity });
    assert.equal(readSourceAuthority(live).state, "active");
    const liveReport = doctor(live);
    assert.equal(liveReport.hub.supported, true); assert.equal(liveReport.hub.leaseRow, true);
    assert.deepEqual(liveReport.issues, []);
    const liveFixture = relayFixture(liveIdentity);
    for (const route of ["relay", "recovery"] as const) planHostStartup(liveFixture.input(live, route));
    assert.ok(liveFixture.untouched());
    store.createBot({ name: "After readers", profileId: "work", engine: "codex" });
    assert.equal(store.listBots().length, 1);
  } finally { store.close(); }
});
