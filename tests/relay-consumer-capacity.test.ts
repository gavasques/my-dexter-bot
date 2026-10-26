import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayEndpoint, RelayStore } from "@dexter/relay";
import { ConsumerError, RelayConsumer, type CurrentRelayAuthority, type HostPort, type RelayPrincipal } from "../packages/relay-consumer/src/index.js";

// Pager-only proof: actual ciphertext/queue/consumer journal. The canonical Host/AppClient
// port is synthetic; this test does not prove enrollment, HostServices wiring or custody.
function fixture(t: TestContext, capacity: number, explicitCapacity: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "dexter-relay-capacity-test-"));
  const hostId = "host_capacity_fixture", ownerId = "owner_capacity_fixture";
  const sender = new RelayEndpoint({ installationId: hostId, ownerId, deviceId: "sender_capacity", generation: 1, keyId: "sender_key" });
  const recipient = new RelayEndpoint({ installationId: hostId, ownerId, deviceId: "recipient_capacity", generation: 1, keyId: "recipient_key" });
  const relay = new RelayStore({ dataDir: join(directory, "relay"), ownerId, installationId: hostId,
    maximumPending: 256, maximumPendingPerRecipient: capacity });
  relay.registerDevice(sender.publicPin);
  relay.registerDevice(recipient.publicPin);
  let restoreFirst = false;
  const principal: RelayPrincipal = { hostId, ownerId, canonicalDeviceId: "canonical_client_fixture", tlsFingerprint: "f".repeat(64),
    role: "client-ios", scopes: [], pinGeneration: 1, bindingRevision: 1, senderPin: sender.publicPin, recipientPin: recipient.publicPin };
  const authority: CurrentRelayAuthority = {
    candidate(envelope) { return envelope.messageId === `message_${capacity}` || (restoreFirst && envelope.messageId === "message_1") ? principal : null; },
    isCurrent() { return true; },
  };
  const unexpected = (): never => { throw Error("notice must never call the canonical turn port"); };
  const host: HostPort = { hostId, ownerId, withWriterLease: work => work(), startTurn: unexpected,
    findTurn: unexpected, checkThread: unexpected, turnInput: unexpected, sourceHash: unexpected };
  const consumer = new RelayConsumer({ host, directory: join(directory, "consumer"), opener: recipient, authority,
    ...(explicitCapacity ? { maximumPendingPerRecipient: capacity } : {}),
    transport: { async poll(request) { return relay.poll(request); }, async ack(request) { return relay.ack(request); }, async close() {} } });
  t.after(async () => { await consumer.close(); relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = Date.now();
  for (let sequence = 1; sequence <= capacity; sequence++) relay.enqueue(sender.seal(recipient.publicPin,
    { messageId: `message_${sequence}`, sequence, type: "event", createdAt: now, expiresAt: now + 60_000 },
    Buffer.from(JSON.stringify({ version: 1, operation: "notice.received", operationId: `operation_${sequence}`, noticeId: `notice_${sequence}` }))));
  return { consumer, relay, restoreFirst() { restoreFirst = true; } };
}

test("a legitimate delivery beyond 130 denied predecessors is accepted with trusted recipient capacity 131", { timeout: 15_000 }, async t => {
  const lab = fixture(t, 131, true);
  let accepted = 0;
  for (let wake = 0; wake < 14; wake++) accepted += (await lab.consumer.wake()).inert;
  assert.equal(accepted, 1, "later accepted ciphertext must not be starved by repeatedly denied earlier entries");
  assert.equal(lab.consumer.status().counts.acked, 1);
  lab.restoreFirst();
  assert.equal((await lab.consumer.wake()).inert, 1, "temporarily denied oldest delivery is revisited after the bounded sweep");
  assert.equal(lab.consumer.status().counts.acked, 2);
});

test("default recipient capacity 128 retains the existing bounded sweep and revisits blocked input", { timeout: 15_000 }, async t => {
  const lab = fixture(t, 128, false);
  let accepted = 0;
  for (let wake = 0; wake < 13; wake++) accepted += (await lab.consumer.wake()).inert;
  assert.equal(accepted, 1);
  lab.restoreFirst();
  assert.equal((await lab.consumer.wake()).inert, 1);
});

test("untrusted or unsupported capacity refuses before creating a journal", async t => {
  const directory = mkdtempSync(join(tmpdir(), "dexter-relay-capacity-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hostId = "host_capacity_fixture", ownerId = "owner_capacity_fixture";
  const endpoint = new RelayEndpoint({ installationId: hostId, ownerId, deviceId: "recipient_capacity", generation: 1, keyId: "recipient_key" });
  const unexpected = (): never => { throw Error("configuration must refuse before any port is used"); };
  const host: HostPort = { hostId, ownerId, withWriterLease: unexpected, startTurn: unexpected, findTurn: unexpected,
    turnInput: unexpected, sourceHash: unexpected, checkThread: unexpected };
  for (const value of [0, -1, 4097, 1.5, NaN, Infinity, "131", null]) {
    const absent = join(directory, "absent");
    assert.throws(() => new RelayConsumer({ host, directory: absent, opener: endpoint, authority: { candidate: unexpected, isCurrent: unexpected },
      transport: { poll: unexpected, ack: unexpected, close: unexpected }, maximumPendingPerRecipient: value as number }),
      error => error instanceof ConsumerError && error.code === "invalid_input");
    assert.equal(existsSync(absent), false);
  }
});
