// G8 relay recovery composition (Opus author round 2): HostServices explicit recovery mode, owner UDS closed wire and
// operator CLI over a REAL restored destination (approved relay R3 fixtures: real rotation, real operations transfer).
// Real HostStore/SQLite/app-client mTLS listener/owner UDS; synthetic in-memory custody and TLS identities only.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { HostStore } from "@dexter/hub";
import { RelayRecoveryMaintenance } from "@dexter/relay-host";
import { HostServices } from "../packages/cli/src/host-services.js";
import { ownerControlRequest } from "../packages/cli/src/owner-control-client.js";
import { OWNER_CONTROL_PROTOCOL, parseOwnerControlRequest } from "../packages/cli/src/owner-control.js";
import { memoryTLS } from "./fixtures/online-memory-tls.js";
import { ASSOC_TABLES, CONSUMER_TABLES, assocPath, consumerPath, defer as deferRestored, dump, seedRotatedSource, transfer } from "./fixtures/relay-reapproval-lab.js";
import { code, countingEngine, defer, dexter, lab, pairOverOwner, parse, pinFile, relayCustody, sender, type Json } from "./fixtures/relay-recovery-lab.js";

const ask = async (socket: string, op: string, args: Json): Promise<Json> => { const out = await ownerControlRequest(socket, { op, args } as never); assert.equal(out.kind, "response"); return (out as { response: Json }).response; };
interface Restored { root: string; dest: string; hostId: string; ownerId: string; peer: string; recipientGeneration: number }
/** Real restored destination: rotated source (recipient gen2, peer re-enrolled gen2, tombstones, pending ACK) transferred. */
async function restored(t: TestContext): Promise<Restored> {
  const s = await seedRotatedSource(t); const { dest } = await transfer(s);
  return { root: s.root, dest, hostId: s.hostId, ownerId: s.ownerId, peer: s.peer, recipientGeneration: 2 };
}
const relayFiles = (dest: string) => ({ assoc: dump(assocPath(dest), ASSOC_TABLES), consumer: dump(consumerPath(dest), CONSUMER_TABLES) });
function recoveryHost(t: TestContext, r: Restored, extra: Record<string, unknown> = {}, socket = join(r.root, "o.sock")) {
  const engine = countingEngine();
  const host = new HostServices({ dataDir: r.dest, enableEngines: true, makeDriver: engine.makeDriver, appClients: { identity: memoryTLS() }, ownerControl: { socketPath: socket }, relayRecovery: {}, ...extra } as never);
  let closed = false; deferRestored(t, async () => { if (!closed) await host.shutdown({ graceMs: 2000 }).catch(() => undefined); });
  return { host, socket, engine, async close() { closed = true; await host.shutdown({ graceMs: 2000 }); } };
}

test("closed recovery/ACK wire: caller authority, custody, provider, opener, grants or secrets never parse; unconfigured modes stay unavailable", async t => {
  const pin = sender({ hostId: "host_1", ownerId: "owner_1" }, "dev_x", 1).publicPin;
  const parsed = (op: string, args: unknown) => parseOwnerControlRequest({ protocol: OWNER_CONTROL_PROTOCOL, op, args });
  const enroll = { deviceId: "dev_x", expectedRevision: null, expectedHostRevision: 2, bindingRevision: 1, senderPin: pin };
  assert.deepEqual(parsed("relay.recovery.enroll", enroll).args, enroll);
  for (const extra of ["binding", "custody", "provider", "opener", "grants", "secret", "privateKey", "transport", "authority"])
    assert.throws(() => parsed("relay.recovery.enroll", { ...enroll, [extra]: {} }), SyntaxError, extra);
  for (const bad of [{ ...pin, privateKey: "x" }, { ...pin, generation: 0 }, { ...pin, generation: 1.5 }, { ...pin, signingPublicKey: "A".repeat(200) }, { ...pin, keyId: "bad key" }, { ...pin, generation: "1" }])
    assert.throws(() => parsed("relay.recovery.rotate", { pin: bad, expectedHostRevision: 1 }), SyntaxError);
  assert.throws(() => parsed("relay.recovery.rotate", { pin, expectedHostRevision: 0 }), SyntaxError);
  assert.throws(() => parsed("relay.recovery.rotate", { pin, expectedHostRevision: 1, custody: {} }), SyntaxError);
  assert.throws(() => parsed("relay.recovery.enroll", { ...enroll, expectedRevision: 0 }), SyntaxError);
  for (const limit of [0, 65, 1.5, "1"]) assert.throws(() => parsed("relay.recovery.acks", { limit }), SyntaxError);
  assert.throws(() => parsed("relay.acks", { limit: 1, after: "x", cursor: 1 }), SyntaxError);
  const reconcile = { deviceId: "dev_x", operationId: "op_1", messageId: "msg_1", receiptId: "rcpt_1", issuerHash: "a".repeat(64) };
  assert.equal(parsed("relay.ack-reconcile", reconcile).op, "relay.ack-reconcile");
  for (const [k, v] of [["issuerHash", "A".repeat(64)], ["receiptId", "r/1"], ["request", {}]] as const) assert.throws(() => parsed("relay.ack-reconcile", { ...reconcile, [k]: v }), SyntaxError);
  // A host without relay or recovery: every relay owner op is refused with no effect.
  const dir = lab(t), socket = join(dir, "o.sock");
  const host = new HostServices({ dataDir: join(dir, "h"), appClients: { identity: memoryTLS() }, ownerControl: { socketPath: socket } });
  defer(t, () => host.shutdown()); await host.startOwnerControl();
  for (const [op, args] of [["relay.recovery.status", {}], ["relay.recovery.rotate", { pin, expectedHostRevision: 1 }], ["relay.recovery.enroll", enroll], ["relay.acks", { limit: 1 }], ["relay.ack-reconcile", reconcile]] as const)
    assert.deepEqual((await ask(socket, op, args)).error, { code: "unavailable", effect: "none" }, op);
  assert.equal(existsSync(join(dir, "h", "relay-host")), false);
  const cli = await dexter(["relay", "recovery", "status", "--owner-control-socket", socket]);
  assert.equal(cli.code, 1); assert.deepEqual(parse(cli.stderr), { error: "unavailable", effect: "none" });
});

test("recovery mode is explicit, exclusive and pure; a missing recovery source is never bootstrapped and releases the writer", async t => {
  const dir = lab(t), c = relayCustody({ hostId: "h", ownerId: "o" }, 2);
  const transport = { async poll() { return { deliveries: [], cursor: 0 }; }, async ack() { return { receiptId: "x" }; }, async close() {} };
  const configs: Array<[string, Record<string, unknown>]> = [
    ["relay+recovery", { relay: { recipient: c.pin, custody: c.provider, custodyMode: "laboratory-memory", transport, transportOwnership: "borrowed", deployment: { maximumPendingPerRecipient: 8 } }, enableEngines: true, appClients: { identity: memoryTLS() }, relayRecovery: {} }],
    ["no app clients", { relayRecovery: {} }],
    ["label/mode mismatch", { appClients: { identity: memoryTLS() }, relayRecovery: { nextRecipient: { custody: c.provider, custodyMode: "persistent" } } }],
    ["extra key", { appClients: { identity: memoryTLS() }, relayRecovery: { nextRecipient: { custody: c.provider, custodyMode: "laboratory-memory" }, privateKey: "x" } }],
    ["bad bound", { appClients: { identity: memoryTLS() }, relayRecovery: { maximumAssociations: 0 } }],
  ];
  for (const [label, extra] of configs) {
    const data = join(dir, label.replace(/[^a-z]/g, ""));
    assert.throws(() => new HostServices({ dataDir: data, ...extra } as never), code("invalid_input"), label);
    assert.equal(existsSync(data), false, label);
  }
  assert.equal(c.signStarted, false); assert.equal(c.closes, 0);
  const data = join(dir, "fresh"); mkdirSync(data, { mode: 0o700 });
  assert.throws(() => new HostServices({ dataDir: data, appClients: { identity: memoryTLS() }, relayRecovery: {} }), code("unavailable"));
  assert.equal(existsSync(join(data, "relay-host")), false);
  const reopened = new HostStore({ dataDir: data }); reopened.close();
});

test("public status/peer; rotation only to the trusted configured next provider pin with exact CAS; refusals write nothing", async t => {
  const r = await restored(t); const before = relayFiles(r.dest);
  const none = recoveryHost(t, r); await none.host.startOwnerControl();
  const st = (await ask(none.socket, "relay.recovery.status", {})).result;
  assert.deepEqual({ relay: st.relay, gen: st.recipient.generation, rev: st.hostRevision, active: st.active, revoked: st.revoked, next: st.nextRecipient },
    { relay: "inactive", gen: 2, rev: 2, active: 1, revoked: 2, next: null });
  assert.deepEqual(Object.keys(st.recipient).sort(), ["deviceId", "encryptionPublicKey", "generation", "installationId", "keyId", "ownerId", "signingPublicKey"]);
  // Real gen2 pending ACK (committed, canonical turn proven) needs the recipient custody; synthetic-issuer rows never qualify.
  assert.deepEqual(st.acks, { pending: 3, reconcilable: 0, requires_custody: 1, obsolete_recipient_generation: 0, effect_unconfirmed: 0, proof_missing: 0, provenance_unverifiable: 2 });
  const page = (await ask(none.socket, "relay.recovery.acks", { limit: 64 })).result;
  assert.equal(page.pending, 3); assert.equal(page.truncated, false);
  for (const item of page.items) assert.deepEqual(Object.keys(item).sort(), ["deviceId", "disposition", "issuerHash", "logicalHash", "messageId", "operationId", "operationState", "receiptId", "recipientGeneration", "recipientKeyId", "requestRetained", "threadId", "turnId"]);
  const real = page.items.find((i: Json) => i.disposition === "requires_custody");
  assert.deepEqual({ state: real.operationState, retained: real.requestRetained, gen: real.recipientGeneration }, { state: "committed", retained: true, gen: 2 });
  const firstPage = (await ask(none.socket, "relay.recovery.acks", { limit: 1 })).result;
  assert.equal(firstPage.items.length, 1); assert.equal(firstPage.truncated, true);
  const second = (await ask(none.socket, "relay.recovery.acks", { limit: 64, after: firstPage.items[0].messageId })).result;
  assert.equal(second.items.length, 2);
  const peer = (await ask(none.socket, "relay.recovery.peer", { deviceId: r.peer })).result;
  assert.equal(peer.association.status, "active"); assert.equal(peer.binding.status, "revoked", "activation revoked the restored binding");
  const next = relayCustody(r, 3);
  assert.deepEqual((await ask(none.socket, "relay.recovery.rotate", { pin: next.pin, expectedHostRevision: 2 })).error, { code: "authority_unavailable", effect: "none" });
  await none.close(); assert.deepEqual(relayFiles(r.dest).assoc, before.assoc);
  const host = recoveryHost(t, r, { relayRecovery: { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" } } }, join(r.root, "p.sock"));
  await host.host.startOwnerControl();
  assert.deepEqual((await ask(host.socket, "relay.recovery.status", {})).result.nextRecipient, { deviceId: "relay_host", generation: 3, keyId: "host_key_3" });
  const other = relayCustody(r, 3), skipped = relayCustody(r, 4);
  for (const [pin, rev, expected] of [[other.pin, 2, "conflict"], [skipped.pin, 2, "conflict"], [next.pin, 1, "conflict"]] as const)
    assert.deepEqual((await ask(host.socket, "relay.recovery.rotate", { pin, expectedHostRevision: rev })).error.code, expected);
  // Operator CLI as a separate process, public pin file only.
  const file = pinFile(r.root, "next-pin.json", next.pin);
  const out = await dexter(["relay", "recovery", "rotate", "--owner-control-socket", host.socket, "--pin-file", file, "--expected-host-revision", "2"]);
  assert.equal(out.code, 0, out.stderr); assert.deepEqual(parse(out.stdout), { status: "rotated", recipient: { deviceId: "relay_host", generation: 3, keyId: "host_key_3" }, hostRevision: 3, tombstoned: 1, grantsCreated: 0 });
  const replay = await dexter(["relay", "recovery", "rotate", "--owner-control-socket", host.socket, "--pin-file", file, "--expected-host-revision", "2"]);
  assert.equal(replay.code, 1); assert.deepEqual(parse(replay.stderr), { error: "conflict", effect: "none" });
  const after = (await ask(host.socket, "relay.recovery.acks", { limit: 64 })).result;
  assert.deepEqual(after.items.map((i: Json) => i.disposition).sort(), ["obsolete_recipient_generation", "provenance_unverifiable", "provenance_unverifiable"], "rotation makes the old-generation receipt terminally obsolete");
  await host.close();
  assert.equal(next.signStarted, false); assert.equal(next.decryptStarted, false); assert.equal(next.closes, 0, "recovery never invokes or closes the next provider");
  assert.equal(host.engine.opens + host.engine.turns, 0);
  const assoc = relayFiles(r.dest).assoc;
  assert.equal(assoc.metadata![0].host_revision, 3); assert.equal(assoc.pins!.length, before.assoc.pins!.length + 1);
  for (const row of before.assoc.history!) assert.ok(assoc.history!.some((h: Json) => JSON.stringify(h) === JSON.stringify(row)), "history kept");
  assert.deepEqual(relayFiles(r.dest).consumer, before.consumer, "consumer journal untouched");
});

test("enrollment uses the fresh server-side binding: restored peers stay tombstoned; a freshly paired peer enrolls once with a fresh sender", async t => {
  const r = await restored(t); const h = recoveryHost(t, r); await h.host.startOwnerControl();
  const enroll = (args: Json) => ask(h.socket, "relay.recovery.enroll", args);
  const restoredSender = sender(r, r.peer, 3).publicPin;
  assert.deepEqual((await enroll({ deviceId: r.peer, expectedRevision: 2, expectedHostRevision: 2, bindingRevision: 1, senderPin: restoredSender })).error, { code: "forbidden", effect: "none" }, "restored binding is revoked");
  assert.deepEqual((await enroll({ deviceId: "dev_unknown", expectedRevision: null, expectedHostRevision: 2, bindingRevision: 1, senderPin: sender(r, "dev_unknown", 1).publicPin })).error.code, "forbidden");
  // Owner pairing works in recovery mode WITHOUT the normal relay: fresh offer -> mTLS claim -> approval.
  const fresh = await pairOverOwner(h.socket, memoryTLS());
  const s1 = sender(r, fresh.deviceId, 1).publicPin;
  const base = { deviceId: fresh.deviceId, expectedRevision: null, expectedHostRevision: 2, bindingRevision: fresh.bindingRevision, senderPin: s1 };
  for (const [label, args, expected] of [
    ["binding CAS", { ...base, bindingRevision: fresh.bindingRevision + 1 }, "conflict"],
    ["phantom peer revision", { ...base, expectedRevision: 1 }, "conflict"],
    ["stale host revision", { ...base, expectedHostRevision: 1 }, "forbidden"],
    ["skipped sender generation", { ...base, senderPin: sender(r, fresh.deviceId, 2).publicPin }, "conflict"],
    ["sender for another device", { ...base, senderPin: sender(r, "dev_other", 1).publicPin }, "forbidden"],
  ] as const) assert.equal((await enroll(args)).error.code, expected, label);
  const cliPin = pinFile(r.root, "sender.json", s1);
  const ok = await dexter(["relay", "recovery", "enroll", fresh.deviceId, "--owner-control-socket", h.socket, "--sender-pin-file", cliPin, "--expected-revision", "none", "--expected-host-revision", "2", "--binding-revision", String(fresh.bindingRevision)]);
  assert.equal(ok.code, 0, ok.stderr); assert.deepEqual(parse(ok.stdout), { status: "enrolled", deviceId: fresh.deviceId, revision: 1, grantsCreated: 0 });
  assert.equal((await enroll(base)).error.code, "conflict", "replay refused: never bumps an active association");
  assert.equal((await ask(h.socket, "relay.recovery.peer", { deviceId: fresh.deviceId })).result.association.status, "active");
  await h.close(); assert.equal(h.engine.opens + h.engine.turns, 0);
  const db = new DatabaseSync(join(r.dest, "dexter.sqlite"), { readOnly: true }); try { assert.equal(Number(db.prepare("SELECT count(*) AS n FROM grants").get()!.n), 0); } finally { db.close(); }
});

test("writer loss refuses at the final boundary; retained references refuse after stop; failed recovery close quarantines the writer", async t => {
  const r = await restored(t); const next = relayCustody(r, 3);
  const h = recoveryHost(t, r, { relayRecovery: { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" } } }); await h.host.startOwnerControl();
  const facade = h.host.relayRecoveryAdmin; const before = relayFiles(r.dest);
  const raw = new DatabaseSync(join(r.dest, "dexter.sqlite")); const token = String(raw.prepare("SELECT token FROM host_lease WHERE id=1").get()!.token);
  raw.prepare("UPDATE host_lease SET token=? WHERE id=1").run("synthetic_lost_writer_" + randomUUID());
  assert.deepEqual((await ask(h.socket, "relay.recovery.rotate", { pin: next.pin, expectedHostRevision: 2 })).error, { code: "host_locked", effect: "none" });
  assert.throws(() => facade.rotate({ pin: next.pin, expectedHostRevision: 2 }), code("host_locked"));
  raw.prepare("UPDATE host_lease SET token=? WHERE id=1").run(token); raw.close();
  await h.close();
  assert.deepEqual(relayFiles(r.dest), before, "nothing written under a lost writer");
  assert.throws(() => facade.status(), code("conflict"), "retained facade refuses after stop");
  assert.throws(() => h.host.relayRecoveryAdmin, code("conflict"));
  // A failed recovery close at shutdown is cached and quarantines the canonical writer.
  const q = new HostServices({ dataDir: r.dest, appClients: { identity: memoryTLS() }, relayRecovery: {} });
  chmodSync(assocPath(r.dest), 0o644);
  await assert.rejects(q.shutdown({ graceMs: 2000 })); await assert.rejects(q.shutdown({ graceMs: 2000 }));
  assert.throws(() => new HostStore({ dataDir: r.dest }), code("host_locked"));
  await assert.rejects(q.quiesceForMaintenance());
  chmodSync(assocPath(r.dest), 0o600);
  // The failed native handle stays quarantined in this process: the same file cannot be reopened here.
  assert.throws(() => new RelayRecoveryMaintenance({ hostId: r.hostId, ownerId: r.ownerId, withWriterLease: <T>(fn: () => T) => fn() } as never, { binding: () => null }, r.dest), code("host_locked"));
});

test("constructor rollback owns the recovery handle: a later failure closes it first and keeps the first cause; a failed close retains the writer", async t => {
  for (const tamper of [false, true]) {
    const r = await restored(t);
    let fired = 0; const maintenance = { get graceMs() { fired++; if (tamper) chmodSync(assocPath(r.dest), 0o644); return 5; } };
    let caught: unknown;
    try { new HostServices({ dataDir: r.dest, appClients: { identity: memoryTLS() }, relayRecovery: {}, authorityMaintenance: maintenance as never }); } catch (e) { caught = e; }
    assert.equal(fired > 0, true);
    if (!tamper) {
      assert.ok(caught && (caught as { code?: string }).code === "invalid_input", "first cause propagated");
      const reopened = new HostStore({ dataDir: r.dest }); reopened.close();
      assert.deepEqual(readdirSync(join(r.dest, "relay-host")).sort(), ["relay-associations.sqlite", "relay-consumer.sqlite"]);
    } else {
      assert.ok(caught instanceof AggregateError, "cleanup failure aggregated");
      assert.equal(((caught as AggregateError).cause as { code?: string }).code, "invalid_input", "construction cause preserved");
      assert.throws(() => new HostStore({ dataDir: r.dest }), code("host_locked"), "writer retained after failed rollback close");
      chmodSync(assocPath(r.dest), 0o600);
    }
  }
});

test("relay-service CLI: the distributed entry keeps requiring private TLS files; the in-memory embedding refuses configs naming them", async t => {
  const { fork } = await import("node:child_process"); const { writeFileSync } = await import("node:fs");
  const dir = lab(t), tls = memoryTLS(), base = { version: 1, dataDir: join(dir, "relay"), ownerId: "owner_1", installationId: "host_1", host: "127.0.0.1", port: 0, pins: [] };
  const run = async (fixture: string, config: Json, sendTls: boolean) => {
    const path = join(dir, `${randomUUID()}.json`); writeFileSync(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const child = fork(new URL(`./fixtures/${fixture}`, import.meta.url), ["--config", path], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", b => { stderr += String(b); }); child.stdout!.resume();
    if (sendTls) child.send({ key: tls.keyPem, cert: tls.certPem }); else child.disconnect();
    const exit = await new Promise<number | null>(r => child.once("exit", r)); return { exit, error: parse(stderr.trim().split("\n")[0]!).error };
  };
  assert.deepEqual(await run("relay-service-cli.js", base, false), { exit: 1, error: "config_invalid" }, "bin path without TLS files");
  assert.deepEqual(await run("relay-service-memory-cli.js", { ...base, tlsKeyFile: join(dir, "absent.key"), tlsCertFile: join(dir, "absent.crt") }, true), { exit: 1, error: "config_invalid" }, "seam cannot be mixed with files");
  assert.equal(existsSync(join(dir, "relay")), false, "refused before opening any store");
  assert.deepEqual(readdirSync(dir).filter(n => !n.endsWith(".json")), []);
});
