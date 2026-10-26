import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { HostError, HostStore, type ExistingHostIdentity } from "@dexter/hub";
import type { EngineDriver } from "@dexter/engines";
import type { EngineId } from "@dexter/contracts";
import type { RelayHostOptions } from "@dexter/relay-host";
import type { RelayTransport } from "@dexter/relay-consumer";
import { HostServices } from "../packages/cli/src/host-services.js";
import { planHostStartup, type HostStartupInput } from "../packages/cli/src/host-startup.js";
import { memoryCustody, memoryTLS } from "./fixtures/relay-host-lab.js";

// Synthetic only: private temporary directories, store-minted identities, laboratory-labelled in-memory custody,
// fixture engines. No real data directory, key, auth file, network or physical custody.
const code = (name: string) => (error: unknown) => error instanceof HostError && error.code === name;
const dirOf = (t: TestContext, prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
};
const driver = (id: EngineId): EngineDriver => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
  async status() { return { engine: id, installed: true, version: "fixture", authentication: "authenticated", billing: "subscription" }; },
  async open(threadId) { return { threadId, nativeCursor: "synthetic" }; },
  async *turn(session, turnId) { yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
  async respondToTool() {}, async interrupt() {}, async close() {} });
/** Initialized canonical store, identity minted by the store itself, writer released. */
function seeded(data: string): { data: string; identity: ExistingHostIdentity } {
  const store = new HostStore({ dataDir: data }), identity = { installationId: store.hostId, ownerId: store.ownerId };
  store.close(); return { data, identity };
}
/** Every entry with type, mode and content hash: byte-level before/after evidence (empty when absent). */
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
const EMPTY_SHA256 = createHash("sha256").digest("hex");
/**
 * Refusal evidence: every entry present before, the main file and
 * any WAL included, keeps its type, mode and bytes (only SQLite's rebuildable `-shm` may change), and nothing is added
 * but SQLite coordination files: an EMPTY `-wal` and a `-shm`. These carry no installation, authority or content.
 */
function preserved(after: string[], before: string[], label: string): void {
  const path = (entry: string) => entry.split("|")[0]!, shm = (entry: string) => path(entry) === "./dexter.sqlite-shm";
  const prior = new Set(before.map(path));
  assert.deepEqual(after.filter(entry => prior.has(path(entry)) && !shm(entry)), before.filter(entry => !shm(entry)),
    `${label}: main file, WAL and every other entry keep their bytes`);
  const added = after.filter(entry => !prior.has(path(entry)));
  assert.ok(added.every(entry => shm(entry) || new RegExp(`^\\./dexter\\.sqlite-wal\\|f\\|[0-7]+\\|${EMPTY_SHA256}$`).test(entry)),
    `${label}: only an empty -wal and a -shm may appear (${added.map(path).join(", ")})`);
}
/** Logical state read `immutable` (creates nothing beside the file): schema, identity, authority, lease and event counts. */
function logical(data: string): unknown {
  const path = join(data, "dexter.sqlite");
  if (!existsSync(path)) return "absent";
  const location = pathToFileURL(path); location.search = "immutable=1";
  try {
    const db = new DatabaseSync(location, { readOnly: true });
    try {
      const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown> | undefined;
      return { schema: one("PRAGMA user_version")?.["user_version"], meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
        authority: one("SELECT installation_id, owner_id, epoch, state, checkpoint_id FROM host_authority WHERE id = 1") ?? null,
        leases: one("SELECT COUNT(*) AS n FROM host_lease")?.["n"], events: one("SELECT COUNT(*) AS n FROM events")?.["n"] };
    } finally { db.close(); }
  } catch { return "unreadable"; }
}
/** Public identity comparison only (booleans): the persisted installation/owner still equal `expected`. No other content is read. */
function holds(data: string, expected: ExistingHostIdentity): boolean {
  const db = new DatabaseSync(join(data, "dexter.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT installation_id, owner_id FROM host_authority WHERE id = 1").get() as Record<string, unknown> | undefined;
    return row?.["installation_id"] === expected.installationId && row?.["owner_id"] === expected.ownerId;
  } finally { db.close(); }
}
const writerFree = (data: string) => { const reopened = new HostStore({ dataDir: data }); reopened.close(); };
function relayFixture(identity: ExistingHostIdentity) {
  const custody = memoryCustody({ ...identity, deviceId: "relay_host", generation: 1, keyId: "host_key" });
  let closes = 0, polls = 0;
  const transport: RelayTransport = { async poll() { polls++; return { deliveries: [], cursor: 0 }; }, async ack() { throw Error("unexpected ack"); }, async close() { closes++; } };
  const options: RelayHostOptions = { recipient: custody.pin, custody: custody.provider, custodyMode: "laboratory-memory", transport,
    transportOwnership: "owned", deployment: { maximumPendingPerRecipient: 16 } };
  return { custody, options, get closes() { return closes; }, get polls() { return polls; } };
}
const relayInput = (data: string, relay: RelayHostOptions): HostStartupInput => ({ route: "laboratory",
  options: { dataDir: data, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } }, providers: { relay }, makeDriver: driver });

test("existing-only open admits a valid closed installation with a stable identity and creates nothing new", t => {
  const dir = dirOf(t, "dx-existing-valid-"), seed = seeded(join(dir, "host")), before = tree(seed.data);
  const store = new HostStore({ dataDir: seed.data, existingInstallation: { ...seed.identity } });
  assert.equal(store.hostId, seed.identity.installationId); assert.equal(store.ownerId, seed.identity.ownerId);
  const bot = store.createBot({ profileId: "profile_synthetic", name: "Synthetic", engine: "claude" });
  assert.equal(bot.ownerId, seed.identity.ownerId);
  assert.equal(store.authorityStatus().state, "active");
  store.close();
  // Default reopen sees the same installation; nothing was migrated, re-minted or added beside the database.
  const again = new HostStore({ dataDir: seed.data });
  assert.equal(again.hostId, seed.identity.installationId); assert.equal(again.ownerId, seed.identity.ownerId); assert.equal(again.listBots().length, 1);
  again.close();
  assert.deepEqual(tree(seed.data).map(entry => entry.split("|")[0]), before.map(entry => entry.split("|")[0]));
  // A path needing URI escaping opens the same way; a sibling file whose name looks like URI parameters is untouched.
  const odd = join(dir, "e sp?#%é&mode=rwc"), oddSeed = seeded(odd);
  writeFileSync(join(odd, "dexter.sqlite?mode=rwc"), "decoy");
  const decoy = () => tree(odd).filter(entry => entry.startsWith("./dexter.sqlite?")), decoyBefore = decoy(), oddNames = readdirSync(odd).sort();
  const oddStore = new HostStore({ dataDir: odd, existingInstallation: oddSeed.identity });
  assert.equal(oddStore.hostId, oddSeed.identity.installationId); oddStore.close();
  assert.deepEqual(decoy(), decoyBefore); assert.deepEqual(readdirSync(odd).sort(), oddNames);
});

test("existing-only refuses absent, empty, corrupt, unsupported, legacy, inactive and foreign stores before any write", t => {
  const dir = dirOf(t, "dx-existing-refuse-"), base = seeded(join(dir, "base")), other = seeded(join(dir, "other"));
  let checkpointed: ExistingHostIdentity | undefined;
  const legacy = (path: string, version: number) => { seeded(path); const db = new DatabaseSync(join(path, "dexter.sqlite")); db.exec(`PRAGMA user_version = ${version};`); db.close(); };
  const variants: [string, (path: string) => void, string, ExistingHostIdentity?][] = [
    ["absent data directory", () => {}, "conflict"],
    ["absent parent directory", () => {}, "conflict"],
    ["empty private directory", path => { mkdirSync(path, { mode: 0o700 }); }, "conflict"],
    ["zero-byte dexter.sqlite", path => { mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, "dexter.sqlite"), ""); }, "conflict"],
    ["corrupt dexter.sqlite", path => { mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, "dexter.sqlite"), Buffer.alloc(8192, 0x5a)); }, "conflict"],
    ["unversioned foreign SQLite", path => { mkdirSync(path, { mode: 0o700 }); const db = new DatabaseSync(join(path, "dexter.sqlite"));
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (a);"); db.close(); }, "conflict"],
    ["newer schema", path => legacy(path, 99), "conflict"],
    ["legacy schema 3 (never migrated here)", path => legacy(path, 3), "conflict"],
    ["rollback-journal store", path => { seeded(path); const db = new DatabaseSync(join(path, "dexter.sqlite")); db.exec("PRAGMA journal_mode = DELETE;"); db.close(); }, "conflict"],
    ["missing owner identity row", path => { seeded(path); const db = new DatabaseSync(join(path, "dexter.sqlite"), { enableForeignKeyConstraints: false });
      db.exec("DELETE FROM meta WHERE key = 'owner_id';"); db.close(); }, "conflict"],
    ["checkpointed authority (its own pin)", path => { checkpointed = seeded(path).identity; const db = new DatabaseSync(join(path, "dexter.sqlite"));
      db.exec("UPDATE host_authority SET state = 'checkpointed', checkpoint_id = 'ckp_synthetic_checkpoint_0001';"); db.close(); }, "host_locked"],
    ["foreign initialized installation", path => { seeded(path); }, "forbidden"],
    ["same installation, other owner pin", path => { cpSync(base.data, path, { recursive: true }); }, "forbidden",
      { installationId: base.identity.installationId, ownerId: other.identity.ownerId }],
  ];
  for (const [name, prepare, expected, pin] of variants) {
    const data = name === "absent parent directory" ? join(dir, "missing-parent", "host") : join(dir, name.replace(/[^a-z0-9]+/gi, "-"));
    prepare(data);
    const before = tree(data), state = logical(data), parentBefore = existsSync(join(dir, "missing-parent"));
    const admitted = name.startsWith("checkpointed") ? checkpointed! : pin ?? base.identity;
    assert.throws(() => new HostStore({ dataDir: data, existingInstallation: admitted }), code(expected), name);
    // Main bytes and logical state unchanged; at most SQLite's empty -wal/-shm coordination pair is left beside it.
    preserved(tree(data), before, name);
    assert.deepEqual(logical(data), state, `${name}: no identity, authority, lease or event change`);
    assert.equal(existsSync(join(dir, "missing-parent")), parentBefore, name);
  }
  // The admitted identities themselves are untouched by every refusal.
  assert.equal(holds(base.data, base.identity), true); assert.equal(holds(other.data, other.identity), true);
  writerFree(base.data);
});

test("invalid existing identity data refuses without running any getter, trap or coercion hook and without creating files", t => {
  const dir = dirOf(t, "dx-existing-input-"), seed = seeded(join(dir, "host")), absent = join(dir, "absent"), before = tree(seed.data);
  let hooks = 0;
  const id = seed.identity;
  const getter = Object.defineProperty({ ownerId: id.ownerId }, "installationId", { enumerable: true, get() { hooks++; return id.installationId; } });
  const proxy = new Proxy({ ...id }, { get(target, key) { hooks++; return Reflect.get(target, key); }, ownKeys(target) { hooks++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { hooks++; return Reflect.getOwnPropertyDescriptor(target, key); }, getPrototypeOf(target) { hooks++; return Reflect.getPrototypeOf(target); } });
  const coercing = { installationId: { toString() { hooks++; return id.installationId; }, valueOf() { hooks++; return id.installationId; } }, ownerId: id.ownerId };
  class Identity { constructor(readonly installationId: string, readonly ownerId: string) {} }
  const cases: [string, unknown, Record<string, unknown>?][] = [
    ["accessor field", getter], ["proxy", proxy], ["coercible object field", coercing],
    ["extra key", { ...id, epoch: 1 }], ["missing owner", { installationId: id.installationId }],
    ["symbol key", { ...id, [Symbol("x")]: 1 }], ["empty string", { installationId: "", ownerId: id.ownerId }],
    ["non-string", { installationId: 1, ownerId: id.ownerId }], ["array", [id.installationId, id.ownerId]],
    ["class instance", new Identity(id.installationId, id.ownerId)], ["null", null], ["string", id.installationId],
    ["with legacy bootstrap", id, { authorityBootstrap: "legacy_upgrade" }],
    ["with checkpoint recovery", id, { authorityRecovery: { checkpointId: "ckp_synthetic_checkpoint_0001" } }],
    ["with another requested owner", id, { ownerId: "own_someone_else" }],
  ];
  for (const [name, value, extra] of cases) {
    for (const dataDir of [absent, seed.data]) {
      assert.throws(() => new HostStore({ dataDir, existingInstallation: value as ExistingHostIdentity, ...extra }), code("invalid_input"), name);
    }
    assert.equal(existsSync(absent), false, name);
    assert.deepEqual(tree(seed.data), before, name);
  }
  assert.equal(hooks, 0);
  // The same nested data through HostServices is validated by the store: refused before HostStore creates anything.
  assert.throws(() => new HostServices({ dataDir: absent, existingInstallation: proxy as unknown as ExistingHostIdentity }), code("invalid_input"));
  assert.equal(existsSync(absent), false); assert.equal(hooks, 0);
  // Matching requested owner is accepted.
  const store = new HostStore({ dataDir: seed.data, ownerId: id.ownerId, existingInstallation: id }); store.close();
});

test("plan→open race: truncate, replace, remove or swap the accepted store refuses before genesis, providers or relay files", async t => {
  const dir = dirOf(t, "dx-existing-race-");
  const races: [string, "relay" | "recovery", (seed: { data: string; identity: ExistingHostIdentity }) => void, string][] = [
    ["truncate in place (relay)", "relay", s => { truncateSync(join(s.data, "dexter.sqlite"), 0); }, "conflict"],
    ["truncate in place (recovery)", "recovery", s => { truncateSync(join(s.data, "dexter.sqlite"), 0); }, "conflict"],
    ["replace with empty file (relay)", "relay", s => { unlinkSync(join(s.data, "dexter.sqlite")); writeFileSync(join(s.data, "dexter.sqlite"), "", { mode: 0o600 }); }, "conflict"],
    ["replace with empty file (recovery)", "recovery", s => { unlinkSync(join(s.data, "dexter.sqlite")); writeFileSync(join(s.data, "dexter.sqlite"), "", { mode: 0o600 }); }, "conflict"],
    ["remove database file", "relay", s => { unlinkSync(join(s.data, "dexter.sqlite")); }, "conflict"],
    ["remove data directory", "recovery", s => { rmSync(s.data, { recursive: true }); }, "conflict"],
    ["foreign initialized store swapped in at the same path", "relay", s => {
      const foreign = seeded(`${s.data}-foreign`); rmSync(s.data, { recursive: true }); renameSync(foreign.data, s.data); }, "forbidden"],
    ["installation re-initialized at the same path after the plan", "recovery", s => { rmSync(s.data, { recursive: true }); seeded(s.data); }, "forbidden"],
  ];
  for (const [name, route, mutate, expected] of races) {
    const seed = seeded(join(dir, name.replace(/[^a-z0-9]+/gi, "-"))), relay = relayFixture(seed.identity);
    const next = memoryCustody({ ...seed.identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
    const plan = planHostStartup(route === "relay" ? relayInput(seed.data, relay.options) : { route: "laboratory",
      options: { dataDir: seed.data, enableRelayRecovery: true, appClients: { identity: memoryTLS() } },
      providers: { relayRecovery: { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" } } } });
    mutate(seed);
    const before = tree(seed.data), state = logical(seed.data), present = existsSync(join(seed.data, "dexter.sqlite"));
    const swapped = present && statSync(join(seed.data, "dexter.sqlite")).size > 0 ? (() => {
      const db = new DatabaseSync(join(seed.data, "dexter.sqlite"), { readOnly: true });
      try { return db.prepare("SELECT installation_id, owner_id FROM host_authority").get() as { installation_id: string; owner_id: string }; } finally { db.close(); }
    })() : null;
    assert.throws(() => plan.open(), code(expected), name);
    // No genesis: main bytes and logical state unchanged; at most SQLite's empty -wal/-shm pair, and no relay file.
    preserved(tree(seed.data), before, name);
    assert.deepEqual(logical(seed.data), state, `${name}: no identity, authority, lease or event change`);
    assert.equal(existsSync(join(seed.data, "relay-host")), false, name);
    if (swapped) assert.equal(holds(seed.data, { installationId: swapped.installation_id, ownerId: swapped.owner_id }), true, `${name}: swapped identity unchanged`);
    if (present && swapped) assert.equal(holds(seed.data, seed.identity), false, name);
    assert.equal(relay.custody.closes, 0); assert.equal(relay.custody.signStarted, false); assert.equal(relay.closes, 0); assert.equal(relay.polls, 0);
    assert.equal(next.closes, 0); assert.equal(next.signStarted, false);
    assert.throws(() => plan.open(), code("conflict"), `${name}: plan stays single-use`);
  }
});

test("accepted plan opens the unchanged installation existing-only; the old leaseholder keeps its lease when a second writer refuses", async t => {
  const dir = dirOf(t, "dx-existing-lease-"), seed = seeded(join(dir, "host")), relay = relayFixture(seed.identity);
  const host = planHostStartup(relayInput(seed.data, relay.options)).open();
  assert.equal(host.store.hostId, seed.identity.installationId); assert.equal(host.store.ownerId, seed.identity.ownerId);
  const lease = host.store.summary().lease;
  // A second plan against the live writer is refused; the first writer's lease and fence are untouched.
  const second = relayFixture(seed.identity);
  assert.throws(() => planHostStartup(relayInput(seed.data, second.options)).open(), code("host_locked"));
  assert.throws(() => new HostStore({ dataDir: seed.data, existingInstallation: seed.identity }), code("host_locked"));
  assert.deepEqual(host.store.summary().lease, lease);
  host.store.withWriterLease(() => undefined);
  assert.equal(second.custody.closes, 0); assert.equal(second.closes, 0); assert.equal(second.custody.signStarted, false);
  await host.shutdown({ graceMs: 1000 });
  assert.equal(relay.closes, 1); assert.equal(relay.custody.closes, 1);
  assert.equal(holds(seed.data, seed.identity), true);
  writerFree(seed.data);
  // Direct trusted HostServices with a mismatching captured identity refuses before any relay file or provider work.
  const foreign = relayFixture(seed.identity);
  assert.throws(() => new HostServices({ dataDir: seed.data, enableEngines: true, appClients: { identity: memoryTLS() }, relay: foreign.options,
    makeDriver: driver, existingInstallation: { installationId: seed.identity.installationId, ownerId: "own_not_this_owner" } }), code("forbidden"));
  assert.equal(foreign.custody.closes, 0); assert.equal(foreign.closes, 0);
  assert.equal(holds(seed.data, seed.identity), true);
  writerFree(seed.data);
});

test("a live writer in another process cannot be overlapped by an existing-only open, and keeps writing afterwards", async t => {
  const dir = dirOf(t, "dx-existing-process-"), seed = seeded(join(dir, "host"));
  const script = `import { HostStore } from ${JSON.stringify(resolve("packages/hub/dist/index.js"))};
const store = new HostStore({ dataDir: process.argv[1] });
process.stdout.write("ready\\n");
process.stdin.on("data", () => { try { store.createBot({ profileId: "profile_child", name: "Child", engine: "codex" }); process.stdout.write("wrote\\n"); }
  catch (e) { process.stdout.write("refused " + e.code + "\\n"); } });
process.stdin.on("end", () => { store.close(); process.stdout.write("closed\\n"); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, seed.data], { stdio: ["pipe", "pipe", "inherit"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() } });
  const exited = new Promise(r => child.once("exit", r));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let out = "";
  const until = async (text: string) => { for (let i = 0; i < 1000 && !out.includes(text); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(out.includes(text), text); };
  child.stdout.setEncoding("utf8").on("data", chunk => { out += chunk; });
  await until("ready");
  const names = readdirSync(seed.data).sort();
  assert.throws(() => new HostStore({ dataDir: seed.data, existingInstallation: seed.identity }), code("host_locked"));
  assert.throws(() => planHostStartup(relayInput(seed.data, relayFixture(seed.identity).options)).open(), code("host_locked"));
  assert.deepEqual(readdirSync(seed.data).sort(), names);
  child.stdin.write("x"); await until("wrote");
  child.stdin.end(); await until("closed");
  await exited;
  const store = new HostStore({ dataDir: seed.data, existingInstallation: seed.identity });
  assert.equal(store.listBots().length, 1); store.close();
});

test("default first start and direct HostServices remain behavior-compatible (they still create a new installation)", async t => {
  const dir = dirOf(t, "dx-existing-default-"), data = join(dir, "fresh", "host");
  const host = new HostServices({ dataDir: data });
  assert.match(host.store.hostId, /^host_/); assert.equal(host.store.authorityStatus().provenance, "genesis");
  await host.shutdown({ graceMs: 1000 });
  assert.equal(statSync(join(data, "dexter.sqlite")).mode & 0o777, 0o600);
  // The plan without relay/recovery keeps first start (no captured identity is forwarded).
  const plan = planHostStartup({ route: "laboratory", options: { dataDir: join(dir, "plain"), enableEngines: true }, makeDriver: driver });
  const planned = plan.open(); assert.equal(planned.store.authorityStatus().provenance, "genesis");
  await planned.shutdown({ graceMs: 1000 });
});

/** Another process commits with autocheckpoint off and is then SIGKILLed: a genuine committed orphan WAL+SHM pair. */
async function orphanCommit(t: TestContext, data: string, script: string): Promise<void> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, data], { stdio: ["ignore", "pipe", "inherit"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() } });
  const exited = new Promise(r => child.once("exit", r));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise<void>((done, fail) => { child.stdout.once("data", () => done()); child.once("error", fail); void exited.then(() => fail(new Error("exited before commit"))); });
  child.kill("SIGKILL"); await exited;
}
const rawCommit = (sql: string) => `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1] + "/dexter.sqlite");
db.exec(${JSON.stringify(`PRAGMA wal_autocheckpoint = 0; ${sql}`)}); process.stdout.write("committed\\n"); setInterval(() => {}, 10_000);`;
/** Logical state as recovered by a read-only reader (which cannot checkpoint): public identity, authority and counts. */
function recovered(data: string): unknown {
  const db = new DatabaseSync(join(data, "dexter.sqlite"), { readOnly: true });
  try {
    const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
    return { meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      authority: one("SELECT installation_id, owner_id, epoch, state, checkpoint_id FROM host_authority WHERE id = 1"),
      leases: one("SELECT COUNT(*) AS n FROM host_lease")["n"], events: one("SELECT COUNT(*) AS n FROM events")["n"],
      schema: one("PRAGMA user_version")["user_version"] };
  } finally { db.close(); }
}

test("a refused existing-only open never checkpoints or consumes a committed orphan WAL pair", async t => {
  const dir = dirOf(t, "dx-existing-orphan-");
  const cases: [string, "relay" | "recovery" | "store", string, string][] = [
    ["inconsistent committed identity, accepted relay plan", "relay", "UPDATE meta SET value = 'own_synthetic_orphan' WHERE key = 'owner_id';", "conflict"],
    ["inconsistent committed identity, existing-only store", "store", "UPDATE meta SET value = 'own_synthetic_orphan' WHERE key = 'owner_id';", "conflict"],
    ["committed checkpointed authority, accepted recovery plan", "recovery",
      "UPDATE host_authority SET state = 'checkpointed', checkpoint_id = 'ckp_synthetic_checkpoint_0001';", "host_locked"],
    ["committed checkpointed authority, existing-only store", "store",
      "UPDATE host_authority SET state = 'checkpointed', checkpoint_id = 'ckp_synthetic_checkpoint_0001';", "host_locked"],
  ];
  for (const [name, route, sql, expected] of cases) {
    const seed = seeded(join(dir, name.replace(/[^a-z0-9]+/gi, "-"))), relay = relayFixture(seed.identity);
    const next = memoryCustody({ ...seed.identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
    // The plan is accepted while the installation is still valid; the orphan pair appears afterwards.
    const plan = route === "relay" ? planHostStartup(relayInput(seed.data, relay.options)) : route === "recovery" ? planHostStartup({ route: "laboratory",
      options: { dataDir: seed.data, enableRelayRecovery: true, appClients: { identity: memoryTLS() } },
      providers: { relayRecovery: { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" } } } }) : null;
    await orphanCommit(t, seed.data, rawCommit(sql));
    const logical = recovered(seed.data), before = tree(seed.data);
    assert.deepEqual(readdirSync(seed.data).sort(), ["dexter.sqlite", "dexter.sqlite-shm", "dexter.sqlite-wal"], name);
    assert.ok(statSync(join(seed.data, "dexter.sqlite-wal")).size > 0, `${name}: the WAL holds committed frames`);
    assert.throws(() => plan ? plan.open() : new HostStore({ dataDir: seed.data, existingInstallation: seed.identity }), code(expected), name);
    // Main file and WAL are byte-identical and the pair stays in place; the -shm wal-index is SQLite's rebuildable
    // shared memory (any reader rebuilds it), so its presence, not its bytes, is asserted.
    const durable = (entries: string[]) => entries.filter(entry => !entry.startsWith("./dexter.sqlite-shm|"));
    assert.deepEqual(durable(tree(seed.data)), durable(before), `${name}: no checkpoint into the main file and no WAL change`);
    assert.deepEqual(readdirSync(seed.data).sort(), ["dexter.sqlite", "dexter.sqlite-shm", "dexter.sqlite-wal"], `${name}: no sidecar removed`);
    // Still recoverable exactly as committed: no new identity, genesis, lease or event.
    assert.deepEqual(recovered(seed.data), logical, `${name}: committed state unchanged`);
    assert.equal(existsSync(join(seed.data, "relay-host")), false, name);
    assert.equal(relay.custody.closes, 0); assert.equal(relay.custody.signStarted, false); assert.equal(relay.closes, 0); assert.equal(relay.polls, 0);
    assert.equal(next.closes, 0); assert.equal(next.signStarted, false);
  }
});

test("an admitted existing-only open recovers a consistent orphan WAL and releases its read-only companion", async t => {
  const dir = dirOf(t, "dx-existing-recover-"), seed = seeded(join(dir, "host"));
  // A writer of this installation commits a bot and dies holding its lease: crash recovery belongs to the next writer.
  await orphanCommit(t, seed.data, `import { HostStore } from ${JSON.stringify(resolve("packages/hub/dist/index.js"))};
const store = new HostStore({ dataDir: process.argv[1] });
store.createBot({ profileId: "profile_orphan", name: "Orphan", engine: "codex" }); process.stdout.write("committed\\n"); setInterval(() => {}, 10_000);`);
  assert.deepEqual(readdirSync(seed.data).sort(), ["dexter.sqlite", "dexter.sqlite-shm", "dexter.sqlite-wal"]);
  const store = new HostStore({ dataDir: seed.data, existingInstallation: seed.identity });
  assert.equal(store.hostId, seed.identity.installationId); assert.equal(store.ownerId, seed.identity.ownerId);
  assert.equal(store.listBots().length, 1);
  store.close();
  // The writer was the last connection, so its own close checkpointed and removed the pair: no companion outlived the open.
  assert.deepEqual(readdirSync(seed.data).sort(), ["dexter.sqlite"]);
  const again = new HostStore({ dataDir: seed.data, existingInstallation: seed.identity });
  assert.equal(again.listBots().length, 1); again.close();
});

/** Plan through the relay or recovery route, accepted while the seeded installation is still valid. */
function acceptedPlan(route: "relay" | "recovery", seed: { data: string; identity: ExistingHostIdentity }) {
  const relay = relayFixture(seed.identity), next = memoryCustody({ ...seed.identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
  const plan = route === "relay" ? planHostStartup(relayInput(seed.data, relay.options)) : planHostStartup({ route: "laboratory",
    options: { dataDir: seed.data, enableRelayRecovery: true, appClients: { identity: memoryTLS() } },
    providers: { relayRecovery: { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" } } } });
  const untouched = (label: string) => {
    assert.equal(existsSync(join(seed.data, "relay-host")), false, label);
    assert.equal(relay.custody.closes, 0, label); assert.equal(relay.custody.signStarted, false, label); assert.equal(relay.closes, 0, label); assert.equal(relay.polls, 0, label);
    assert.equal(next.closes, 0, label); assert.equal(next.signStarted, false, label);
  };
  return { plan, untouched };
}
const sidecars = (data: string) => readdirSync(data).filter(name => name.startsWith("dexter.sqlite-")).sort();
const walHash = (data: string) => existsSync(join(data, "dexter.sqlite-wal")) ? createHash("sha256").update(readFileSync(join(data, "dexter.sqlite-wal"))).digest("hex") : null;
const mainEntry = (entries: string[]) => entries.find(entry => entry.startsWith("./dexter.sqlite|"));

test("a known-empty or truncated main file refuses before any SQLite read, so a WAL beside it is never consumed", async t => {
  const dir = dirOf(t, "dx-existing-short-"), target = seeded(join(dir, "target"));
  const main = (data: string) => join(data, "dexter.sqlite"), wal = (data: string) => join(data, "dexter.sqlite-wal");
  const synthetic = Buffer.alloc(4152, 0x5a); // deliberately corrupt, nonempty synthetic WAL bytes
  const empty = (data: string) => { mkdirSync(data, { mode: 0o700 }); writeFileSync(main(data), "", { mode: 0o600 }); };
  const cases: [string, (data: string) => ExistingHostIdentity][] = [
    ["zero-byte main beside a synthetic nonempty WAL", data => { empty(data); writeFileSync(wal(data), synthetic); return target.identity; }],
    ["zero-byte main beside a synthetic WAL and -shm pair", data => { empty(data); writeFileSync(wal(data), synthetic);
      writeFileSync(`${main(data)}-shm`, Buffer.alloc(32768)); return target.identity; }],
    ["main shorter than 512 bytes beside a synthetic WAL", data => { const seed = seeded(data); truncateSync(main(data), 100); writeFileSync(wal(data), synthetic); return seed.identity; }],
    ["main off the 512-byte multiple beside a synthetic WAL", data => { const seed = seeded(data); truncateSync(main(data), statSync(main(data)).size - 100);
      writeFileSync(wal(data), synthetic); return seed.identity; }],
    ["symlinked main (never followed)", data => { mkdirSync(data, { mode: 0o700 }); symlinkSync(main(target.data), main(data)); return target.identity; }],
    ["directory in place of the main file", data => { mkdirSync(main(data), { recursive: true, mode: 0o700 }); return target.identity; }],
  ];
  for (const [name, prepare] of cases) {
    const data = join(dir, name.replace(/[^a-z0-9]+/gi, "-")), identity = prepare(data);
    const before = tree(data), targetBefore = tree(target.data);
    assert.throws(() => new HostStore({ dataDir: data, existingInstallation: identity }), code("conflict"), name);
    // No SQLite handle opened at all: every byte, the WAL and any -shm included, is unchanged; nothing is added.
    assert.deepEqual(tree(data), before, `${name}: refused before any SQLite read`);
    assert.deepEqual(tree(target.data), targetBefore, `${name}: symlink target untouched`);
  }
  // Realistic sequence: a plan accepted on the valid store, a genuine committed orphan WAL, then the main truncated to zero.
  for (const route of ["relay", "recovery"] as const) {
    const seed = seeded(join(dir, `orphan-truncated-${route}`)), { plan, untouched } = acceptedPlan(route, seed);
    await orphanCommit(t, seed.data, rawCommit("UPDATE meta SET value = 'own_synthetic_orphan' WHERE key = 'owner_id';"));
    truncateSync(main(seed.data), 0);
    const before = tree(seed.data);
    assert.ok(statSync(wal(seed.data)).size > 0, `${route}: the WAL holds committed frames`);
    assert.throws(() => plan.open(), code("conflict"), route);
    assert.deepEqual(tree(seed.data), before, `${route}: the committed WAL and its -shm are not consumed`);
    untouched(route);
  }
});

test("a refused writer always closes before its read-only companion, so no close-time checkpoint runs whatever the WAL holds", async t => {
  const dir = dirOf(t, "dx-existing-order-"), other = seeded(join(dir, "other"));
  const store = (seed: { data: string }, identity: ExistingHostIdentity) => () => new HostStore({ dataDir: seed.data, existingInstallation: identity });
  // Each case decides nothing from the WAL: empty or absent before the refusal, empty under the writer's lock, or committed.
  const cases: [string, (seed: { data: string; identity: ExistingHostIdentity }) => Promise<() => unknown>, string][] = [
    ["closed store, foreign installation pin (no WAL before)", async seed => store(seed, other.identity), "forbidden"],
    ["closed store, checkpointed authority", async seed => {
      const db = new DatabaseSync(join(seed.data, "dexter.sqlite"));
      db.exec("UPDATE host_authority SET state = 'checkpointed', checkpoint_id = 'ckp_synthetic_checkpoint_0001';"); db.close();
      return store(seed, seed.identity); }, "host_locked"],
    ["empty WAL pair left by a crashed reader", async seed => {
      await orphanCommit(t, seed.data, `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1] + "/dexter.sqlite", { readOnly: true });
db.prepare("PRAGMA schema_version").get(); process.stdout.write("read\\n"); setInterval(() => {}, 10_000);`);
      assert.equal(statSync(join(seed.data, "dexter.sqlite-wal")).size, 0, "crashed reader left an empty WAL");
      return store(seed, other.identity); }, "forbidden"],
    ["accepted relay plan, foreign installation swapped in", async seed => {
      const { plan } = acceptedPlan("relay", seed), foreign = seeded(`${seed.data}-foreign`);
      rmSync(seed.data, { recursive: true }); renameSync(foreign.data, seed.data); return () => plan.open(); }, "forbidden"],
    ["committed orphan WAL", async seed => {
      await orphanCommit(t, seed.data, rawCommit("UPDATE meta SET value = 'own_synthetic_orphan' WHERE key = 'owner_id';"));
      return store(seed, seed.identity); }, "conflict"],
  ];
  for (const [name, prepare, expected] of cases) {
    const seed = seeded(join(dir, name.replace(/[^a-z0-9]+/gi, "-"))), open = await prepare(seed);
    const before = tree(seed.data), wal = walHash(seed.data);
    assert.throws(open, code(expected), name);
    assert.equal(mainEntry(tree(seed.data)), mainEntry(before), `${name}: main file bytes unchanged`);
    // SQLite deletes the WAL and its -shm only after a successful close-time checkpoint, which needs the exclusive lock:
    // the pair still present shows that neither the refused writer's close nor the companion's ran one.
    assert.deepEqual(sidecars(seed.data), ["dexter.sqlite-shm", "dexter.sqlite-wal"], `${name}: no close-time checkpoint ran`);
    assert.equal(walHash(seed.data), wal ?? EMPTY_SHA256, `${name}: WAL bytes unchanged (or left empty)`);
  }
});

/**
 * A plain connection opened afterwards is then the file's only one, so its close checkpoints and deletes the WAL pair.
 * A handle the refused or closed open still held would keep its SQLite lock (in-process too) and the pair would survive.
 */
function noHandleLeft(data: string): boolean {
  const db = new DatabaseSync(join(data, "dexter.sqlite"));
  try { db.prepare("PRAGMA schema_version").get(); } finally { db.close(); }
  return sidecars(data).length === 0;
}

test("existing-only opens release every handle: refusals leave no SQLite lock behind and admitted startups close normally", async t => {
  const dir = dirOf(t, "dx-existing-release-"), other = seeded(join(dir, "other"));
  const foreign = seeded(join(dir, "foreign"));
  for (let i = 0; i < 3; i++) assert.throws(() => new HostStore({ dataDir: foreign.data, existingInstallation: other.identity }), code("forbidden"));
  assert.equal(noHandleLeft(foreign.data), true, "repeated foreign refusals");
  const checkpointed = seeded(join(dir, "checkpointed")), db = new DatabaseSync(join(checkpointed.data, "dexter.sqlite"));
  db.exec("UPDATE host_authority SET state = 'checkpointed', checkpoint_id = 'ckp_synthetic_checkpoint_0001';"); db.close();
  assert.throws(() => new HostStore({ dataDir: checkpointed.data, existingInstallation: checkpointed.identity }), code("host_locked"));
  assert.equal(noHandleLeft(checkpointed.data), true, "checkpointed refusal");
  const orphan = seeded(join(dir, "orphan"));
  await orphanCommit(t, orphan.data, rawCommit("UPDATE meta SET value = 'own_synthetic_orphan' WHERE key = 'owner_id';"));
  assert.throws(() => new HostStore({ dataDir: orphan.data, existingInstallation: orphan.identity }), code("conflict"));
  assert.equal(noHandleLeft(orphan.data), true, "committed orphan refusal");
  const swapped = seeded(join(dir, "swapped")), { plan, untouched } = acceptedPlan("recovery", swapped);
  const replacement = seeded(`${swapped.data}-foreign`); rmSync(swapped.data, { recursive: true }); renameSync(replacement.data, swapped.data);
  assert.throws(() => plan.open(), code("forbidden")); untouched("swapped recovery plan");
  assert.equal(noHandleLeft(swapped.data), true, "refused startup plan");
  // Admitted startup: the companion is released at admission and shutdown closes the writer, the file's last connection.
  const live = seeded(join(dir, "live")), relay = relayFixture(live.identity);
  const host = planHostStartup(relayInput(live.data, relay.options)).open();
  assert.equal(host.store.hostId, live.identity.installationId);
  await host.shutdown({ graceMs: 1000 });
  assert.deepEqual(sidecars(live.data), [], "shutdown closed the last connection: its checkpoint removed the pair");
  assert.equal(relay.closes, 1); assert.equal(relay.custody.closes, 1);
  const again = new HostStore({ dataDir: live.data, existingInstallation: live.identity }); again.close();
  assert.deepEqual(sidecars(live.data), [], "reopened and closed normally");
});
