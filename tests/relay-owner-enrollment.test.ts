import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostStore } from "@dexter/hub";
import { RelayEndpoint } from "@dexter/relay";
import type { RelayTransport } from "@dexter/relay-consumer";
import { HostServices } from "../packages/cli/src/host-services.js";
import { OWNER_CONTROL_PROTOCOL, parseOwnerControlRequest } from "../packages/cli/src/owner-control.js";
import { ownerControlRequest } from "../packages/cli/src/owner-control-client.js";
import { memoryTLS } from "./fixtures/relay-host-lab.js";
import { countingEngine, defer, dexter, lab, pairOverOwner, pinFile, relayCustody } from "./fixtures/relay-recovery-lab.js";

async function setup(t: TestContext) {
  const dir = lab(t, "en-"), dataDir = join(dir, "host"), seed = new HostStore({ dataDir });
  const ids = { hostId: seed.hostId, ownerId: seed.ownerId }; seed.close();
  const custody = relayCustody(ids, 1);
  const transport: RelayTransport = { async poll() { return { deliveries: [], cursor: 0 }; }, async ack() { throw Error("unexpected ACK"); }, async close() {} };
  const services = new HostServices({ dataDir, enableEngines: true, makeDriver: countingEngine().makeDriver, appClients: { identity: memoryTLS() }, ownerControl: { socketPath: join(dir, "o.sock") },
    relay: { recipient: custody.pin, custody: custody.provider, custodyMode: "laboratory-memory", transport, transportOwnership: "owned", deployment: { maximumPendingPerRecipient: 64 } } });
  let closed = false;
  defer(t, async () => { if (!closed) await services.shutdown({ graceMs: 2000 }); });
  await services.startAppClients(); const socket = await services.startOwnerControl();
  const paired = await pairOverOwner(socket, memoryTLS());
  const sender = new RelayEndpoint({ installationId: ids.hostId, ownerId: ids.ownerId, deviceId: paired.deviceId, generation: 1, keyId: "enroll_sender" });
  const args = { deviceId: paired.deviceId, bindingRevision: paired.bindingRevision, expectedRevision: null, expectedHostRevision: 1, senderPin: sender.publicPin };
  async function ask(value: unknown) {
    const reply = await ownerControlRequest(socket, { op: "relay.enroll", args: value } as never);
    assert.equal(reply.kind, "response"); if (reply.kind !== "response") throw Error("missing owner response"); return reply.response;
  }
  async function finish() { await services.shutdown({ graceMs: 2000 }); closed = true; }
  function rows() {
    const db = new DatabaseSync(join(dataDir, "relay-host", "relay-associations.sqlite"), { readOnly: true });
    try { return { associations: db.prepare("SELECT * FROM associations").all(), history: db.prepare("SELECT * FROM history").all() }; } finally { db.close(); }
  }
  return { dir, dataDir, ids, paired, services, sender, args, socket, ask, finish, rows };
}

test("normal owner enrollment refuses serialized binding and uses the same closed revision grammar as recovery", async t => {
  const l = await setup(t), live = l.services.relayAdmin.binding(l.paired.deviceId)!;
  const wire = (op: string, args: unknown) => ({ protocol: OWNER_CONTROL_PROTOCOL, op, args });
  assert.throws(() => parseOwnerControlRequest(wire("relay.enroll", { expectedRevision: null, expectedHostRevision: 1, binding: live, senderPin: l.sender.publicPin })));
  for (const op of ["relay.enroll", "relay.recovery.enroll"]) {
    assert.deepEqual(parseOwnerControlRequest(wire(op, l.args)).args, l.args);
    for (const args of [{ ...l.args, binding: live }, { ...l.args, bindingRevision: "1" }, { ...l.args, expectedRevision: 0 },
      { ...l.args, expectedHostRevision: 1.5 }, { ...l.args, deviceId: "../dev" }, { ...l.args, senderPin: { ...l.sender.publicPin, custody: "inert" } }]) {
      assert.throws(() => parseOwnerControlRequest(wire(op, args)));
    }
  }
  const rejected = await l.ask({ expectedRevision: null, expectedHostRevision: 1, binding: live, senderPin: l.sender.publicPin });
  assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "invalid_request");
  await l.finish(); assert.equal(l.rows().associations.length, 0);
});

test("live canonical binding CAS over real owner UDS enrolls without grants and refuses stale revision", async t => {
  const l = await setup(t);
  const stale = await l.ask({ ...l.args, bindingRevision: l.args.bindingRevision + 1 });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "conflict");
  const enrolled = await l.ask(l.args); assert.equal(enrolled.ok, true);
  if (enrolled.ok) { assert.equal(enrolled.result.deviceId, l.paired.deviceId); assert.equal(enrolled.result.revision, 1); assert.equal(enrolled.result.grantsCreated, 0); }
  assert.equal(l.services.store.summary().counts.grants, 0); assert.equal(l.services.store.listBots().length, 0);
  await l.finish(); const rows = l.rows(); assert.equal(rows.associations.length, 1); assert.equal(rows.history.length, 1);
  assert.equal(rows.associations[0]!.binding_json, rows.history[0]!.binding_json);
  assert.equal(JSON.parse(String(rows.associations[0]!.binding_json)).deviceId, l.paired.deviceId);
});

test("normal owner lookup refuses missing and revoked canonical peers without new association or grant", async t => {
  const l = await setup(t);
  const missing = await l.ask({ ...l.args, deviceId: "dev_missing" });
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.error.code, "forbidden");
  l.services.peersHttp!.revoke(l.paired.deviceId);
  const revoked = await l.ask(l.args); assert.equal(revoked.ok, false); if (!revoked.ok) assert.equal(revoked.error.code, "forbidden");
  assert.equal(l.services.store.summary().counts.grants, 0); await l.finish();
  assert.equal(l.rows().associations.length, 0); assert.equal(l.rows().history.length, 0);
});

test("separate real Dexter CLI enroll names a live binding revision and never requires a serialized binding", async t => {
  const l = await setup(t), pin = pinFile(l.dir, "sender-public.json", l.sender.publicPin);
  const args = ["relay", "enroll", l.paired.deviceId, "--owner-control-socket", l.socket, "--sender-pin-file", pin,
    "--expected-revision", "none", "--expected-host-revision", "1", "--binding-revision", String(l.args.bindingRevision)];
  const reply = await dexter(args); assert.equal(reply.code, 0); assert.equal(reply.stderr, "");
  const result = JSON.parse(reply.stdout); assert.equal(result.deviceId, l.paired.deviceId); assert.equal(result.grantsCreated, 0);
  const duplicate = await dexter(args); assert.equal(duplicate.code, 3); assert.deepEqual(JSON.parse(duplicate.stderr), { error: "conflict", effect: "unknown" });
  const malformed = await dexter([...args, "--binding-file", pin]); assert.equal(malformed.code, 2);
  assert.equal(l.services.store.summary().counts.grants, 0); await l.finish(); assert.equal(l.rows().history.length, 1);
});
