// G8 pre-cut retained ACK reconciliation (Opus author round 2): bounded listing + explicit, proof-gated reconciliation
// over the owner UDS against a REAL RelayStore; plus the owner-wire pin key-order discriminant. Synthetic keys in memory.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { HostStore } from "@dexter/hub";
import { RelayStore } from "@dexter/relay";
import type { HostPort, RelayTransport } from "@dexter/relay-consumer";
import { HostServices } from "../packages/cli/src/host-services.js";
import { ownerControlRequest } from "../packages/cli/src/owner-control-client.js";
import { gate, until } from "./fixtures/relay-host-lab.js";
import { memoryTLS } from "./fixtures/online-memory-tls.js";
import { code, countingEngine, defer, dexter, lab, pairOverOwner, parse, relayCustody, sender, turnEnvelope, type Json } from "./fixtures/relay-recovery-lab.js";
const { ConsumerJournal } = await import(new URL("../../packages/relay-consumer/dist/journal.js", import.meta.url).href) as {
  ConsumerJournal: new (host: HostPort, directory: string) => { prepare(e: object, m: string, r: string, i: string, p: string): unknown; state(d: string, o: string, s: string, t: string | null): void; close(): void } };
const ask = async (socket: string, op: string, args: Json): Promise<Json> => { const out = await ownerControlRequest(socket, { op, args } as never); assert.equal(out.kind, "response"); return (out as { response: Json }).response; };

interface Lab { dir: string; data: string; socket: string; ids: { hostId: string; ownerId: string }; relay: RelayStore; transport: RelayTransport & { acks: number; failNext: boolean; hold: Promise<void> | null; ackStarted: boolean } }
function relayLab(t: TestContext): Lab {
  const dir = lab(t), data = join(dir, "h"), seed = new HostStore({ dataDir: data }); const ids = { hostId: seed.hostId, ownerId: seed.ownerId }; seed.close();
  const relay = new RelayStore({ dataDir: join(dir, "relay"), ownerId: ids.ownerId, installationId: ids.hostId, maximumPendingPerRecipient: 64 }); defer(t, () => relay.close());
  const transport = { acks: 0, failNext: false, hold: null as Promise<void> | null, ackStarted: false,
    async poll(r: Json) { return relay.poll(r); },
    async ack(r: Json) { transport.acks++; transport.ackStarted = true; if (transport.hold) await transport.hold; if (transport.failNext) { transport.failNext = false; throw new Error("synthetic ACK transport loss"); } return relay.ack(r); },
    async close() {} };
  return { dir, data, socket: join(dir, "o.sock"), ids, relay, transport: transport as Lab["transport"] };
}
function relayHost(t: TestContext, l: Lab, custody: { pin: Json; provider: Json }, engine = countingEngine()) {
  const services = new HostServices({ dataDir: l.data, enableEngines: true, makeDriver: engine.makeDriver, appClients: { identity: memoryTLS() }, ownerControl: { socketPath: l.socket },
    relay: { recipient: custody.pin, custody: custody.provider, custodyMode: "laboratory-memory", transport: { poll: (r: Json) => l.transport.poll(r), ack: (r: Json) => l.transport.ack(r), close: () => l.transport.close() }, transportOwnership: "borrowed", deployment: { maximumPendingPerRecipient: 64 } } });
  let closed = false; defer(t, async () => { if (!closed) await services.shutdown({ graceMs: 2000 }).catch(() => undefined); });
  return { services, engine, async close() { closed = true; await services.shutdown({ graceMs: 2000 }); } };
}
const provenanceFor = (b: Json, s: Json, r: Json) => [b.installationId, b.ownerId, b.deviceId, b.fingerprint, b.role, [...b.scopes].sort(), b.generation, b.revision,
  s.deviceId, s.generation, s.keyId, s.signingPublicKey, s.encryptionPublicKey, r.deviceId, r.generation, r.keyId, r.signingPublicKey, r.encryptionPublicKey];

test("explicit ACK reconciliation: exact proof-gated rows only, fresh current-custody ACK, ambiguous loss stays pending, never overlaps a wake", async t => {
  const l = relayLab(t), c1 = relayCustody(l.ids, 1); l.relay.registerDevice(c1.pin);
  let h = relayHost(t, l, c1); await h.services.startOwnerControl();
  const peer = await pairOverOwner(l.socket, memoryTLS()), binding = h.services.relayAdmin.binding(peer.deviceId)!, s1 = sender(l.ids, peer.deviceId, 1);
  l.relay.registerDevice(s1.publicPin);
  h.services.relayAdmin.enroll({ expectedRevision: null, expectedHostRevision: 1, binding, senderPin: s1.publicPin });
  const bot = h.services.store.createBot({ name: "ACK lab", profileId: "personal", engine: "claude" }), thread = h.services.store.createThread(bot.id);
  await h.close();
  // Seed two retained rows with GENUINE current-recipient provenance: one unconfirmed effect, one committed without a canonical turn.
  const store = new HostStore({ dataDir: l.data });
  const port = { hostId: store.hostId, ownerId: store.ownerId, withWriterLease: <T>(fn: () => T) => store.withWriterLease(fn) } as unknown as HostPort;
  const journal = new ConsumerJournal(port, join(l.data, "relay-host")); const provenance = JSON.stringify(provenanceFor(binding, s1.publicPin, c1.pin)), issuer = createHash("sha256").update(provenance).digest("hex");
  const row = (operationId: string) => ({ deviceId: peer.deviceId, operationId, hash: "0".repeat(64), threadId: thread.id, requestId: "rq_" + operationId, issuerHash: issuer, state: "prepared", turnId: null });
  journal.prepare(row("op_unconfirmed"), "msg_unconfirmed", "rcpt_unconfirmed", issuer, provenance);
  journal.prepare(row("op_proofless"), "msg_proofless", "rcpt_proofless", issuer, provenance); journal.state(peer.deviceId, "op_proofless", "committed", "turn_missing");
  journal.close(); store.close();
  h = relayHost(t, l, { pin: c1.pin, provider: c1.freshProvider() }, h.engine); await h.services.startOwnerControl();
  let seq = 0; const send = (op: string) => l.relay.enqueue(turnEnvelope(s1, c1.pin, ++seq, op, thread.id));
  send("op_a"); assert.deepEqual(await h.services.wakeRelay(), { delivered: 1, accepted: 1, replayed: 0, inert: 0, acked: 1, blocked: 0, unknown: 0 });
  const b = send("op_b"); l.transport.failNext = true;
  assert.equal((await h.services.wakeRelay()).unknown, 1);
  await until(() => h.engine.turns === 2);
  const listed = (await ask(l.socket, "relay.acks", { limit: 64 })).result;
  assert.equal(listed.pending, 3);
  const byOp = Object.fromEntries(listed.items.map((i: Json) => [i.operationId, i]));
  assert.deepEqual({ b: byOp.op_b.disposition, u: byOp.op_unconfirmed.disposition, p: byOp.op_proofless.disposition }, { b: "reconcilable", u: "effect_unconfirmed", p: "proof_missing" });
  assert.equal(byOp.op_b.requestRetained, true); assert.equal(byOp.op_b.receiptId, b.receiptId); assert.equal(byOp.op_b.recipientGeneration, 1);
  const target = (i: Json) => ({ deviceId: i.deviceId, operationId: i.operationId, messageId: i.messageId, receiptId: i.receiptId, issuerHash: i.issuerHash });
  const acksBefore = l.transport.acks;
  // Exact identity binding: a forged issuer or receipt is refused before any signing/ACK.
  assert.deepEqual((await ask(l.socket, "relay.ack-reconcile", { ...target(byOp.op_b), issuerHash: "f".repeat(64) })).error, { code: "conflict", effect: "none" });
  assert.deepEqual((await ask(l.socket, "relay.ack-reconcile", { ...target(byOp.op_b), receiptId: "rcpt_forged" })).error, { code: "conflict", effect: "none" });
  // Unconfirmed effect or missing canonical proof: never ACKed, never fabricated as success.
  for (const op of ["op_unconfirmed", "op_proofless"]) assert.equal((await ask(l.socket, "relay.ack-reconcile", target(byOp[op]))).result.status, byOp[op].disposition);
  assert.equal(l.transport.acks, acksBefore);
  // Ambiguous transport loss: exactly one attempt, row stays pending with its retained request; nothing retried.
  l.transport.failNext = true;
  const lost = await dexter(["relay", "ack-reconcile", "--owner-control-socket", l.socket, "--device", peer.deviceId, "--operation", "op_b", "--message", byOp.op_b.messageId, "--receipt", b.receiptId, "--issuer-hash", byOp.op_b.issuerHash]);
  assert.equal(lost.code, 3, lost.stderr); assert.equal(parse(lost.stdout).status, "unknown"); assert.equal(l.transport.acks, acksBefore + 1);
  assert.equal((await ask(l.socket, "relay.acks", { limit: 64 })).result.items.find((i: Json) => i.operationId === "op_b").disposition, "reconcilable");
  // One raw flight: a wake is refused while a reconciliation holds its ACK; the explicit retry then confirms.
  const held = gate(); l.transport.hold = held.promise; l.transport.ackStarted = false;
  const running = ask(l.socket, "relay.ack-reconcile", target(byOp.op_b)); await until(() => l.transport.ackStarted);
  await assert.rejects(h.services.wakeRelay(), code("conflict"));
  l.transport.hold = null; held.resolve();
  assert.equal((await running).result.status, "acked"); assert.equal(l.transport.acks, acksBefore + 2);
  assert.equal((await ask(l.socket, "relay.acks", { limit: 64 })).result.pending, 2);
  assert.equal((await h.services.wakeRelay()).delivered, 0, "the relay confirmed the receipt: nothing is redelivered");
  assert.equal(h.engine.turns, 2, "reconciliation never starts or replays a turn");
  // Rotation: a pending receipt of the old recipient generation becomes terminally obsolete and is never ACKed.
  const c = send("op_c"); l.transport.failNext = true; assert.equal((await h.services.wakeRelay()).unknown, 1); await until(() => h.engine.turns === 3);
  const c2 = relayCustody(l.ids, 2); h.services.relayAdmin.rotateRecipient(c2.pin, 1); await h.close();
  l.relay.registerDevice(c2.pin); l.transport.acks = 0;
  h = relayHost(t, l, c2, h.engine); await h.services.startOwnerControl();
  const after = (await ask(l.socket, "relay.acks", { limit: 64 })).result.items.find((i: Json) => i.receiptId === c.receiptId);
  assert.equal(after.disposition, "obsolete_recipient_generation");
  assert.equal((await ask(l.socket, "relay.ack-reconcile", target(after))).result.status, "obsolete_recipient_generation");
  assert.equal(l.transport.acks, 0); await h.close();
  assert.equal(h.engine.turns, 3);
});

test("owner-wire recipient rotation persists the protocol pin key order: the normal host reopens with the rotated provider", async t => {
  const l = relayLab(t), c1 = relayCustody(l.ids, 1), c2 = relayCustody(l.ids, 2);
  const h = relayHost(t, l, c1); await h.services.startOwnerControl();
  assert.deepEqual((await ask(l.socket, "relay.rotate-recipient", { pin: c2.pin, expectedRevision: 1 })).result, { status: "rotated" });
  await h.close();
  const reopened = relayHost(t, l, c2); assert.equal(reopened.services.relayAdmin.recipient().pin.generation, 2); await reopened.close();
});

test("held drain: shutdown waits for an in-flight owner reconciliation without deadlock; the late ACK is reported unknown, never published", async t => {
  const l = relayLab(t), c1 = relayCustody(l.ids, 1); l.relay.registerDevice(c1.pin);
  const h = relayHost(t, l, c1); await h.services.startOwnerControl();
  const peer = await pairOverOwner(l.socket, memoryTLS()), binding = h.services.relayAdmin.binding(peer.deviceId)!, s1 = sender(l.ids, peer.deviceId, 1);
  l.relay.registerDevice(s1.publicPin); h.services.relayAdmin.enroll({ expectedRevision: null, expectedHostRevision: 1, binding, senderPin: s1.publicPin });
  const thread = h.services.store.createThread(h.services.store.createBot({ name: "Held drain", profileId: "personal", engine: "claude" }).id);
  const queued = l.relay.enqueue(turnEnvelope(s1, c1.pin, 1, "op_held", thread.id)); l.transport.failNext = true;
  assert.equal((await h.services.wakeRelay()).unknown, 1); await until(() => h.engine.turns === 1);
  const row = (await ask(l.socket, "relay.acks", { limit: 8 })).result.items[0];
  const held = gate(); l.transport.hold = held.promise; l.transport.ackStarted = false;
  const reconcile = ask(l.socket, "relay.ack-reconcile", { deviceId: row.deviceId, operationId: row.operationId, messageId: row.messageId, receiptId: queued.receiptId, issuerHash: row.issuerHash });
  await until(() => l.transport.ackStarted);
  let drained = false; const shutdown = h.services.shutdown({ graceMs: 5000 }).then(() => { drained = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(drained, false, "the owner handler and the raw relay flight are drained before the writer is released");
  assert.throws(() => new HostStore({ dataDir: l.data }), code("host_locked"));
  held.resolve(); l.transport.hold = null;
  const answer = await reconcile; await shutdown;
  assert.deepEqual(answer.result.status, "unknown", "relay answered after admission stopped: never published locally as acked");
  const reopened = new HostStore({ dataDir: l.data }); reopened.close();
  assert.equal(h.engine.turns, 1);
});
