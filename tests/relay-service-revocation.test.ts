// G8 relay-service explicit sender revocation (Sonnet author round 1). REAL RelayService/RelayStore in a SEPARATE runCli child
// (trusted memory TLS over IPC, no key file), actual PinnedRelayTransport TLS 1.3 clients. The trusted operator config lists
// public `revokedDevices`; the CLI applies RelayStore.revokeDevice before the listener exists. Synthetic keys live in memory only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RelayEndpoint, type DevicePin } from "@dexter/relay";
import { RelayTransportError, type PinnedRelayTransport } from "@dexter/relay-service";
import { memoryTLS } from "./fixtures/online-memory-tls.js";
import { defer, lab } from "./fixtures/relay-recovery-lab.js";
import { refusedService, startService } from "./fixtures/relay-revocation-lab.js";

const ids = { ownerId: "owner_rv", installationId: "host_rv" };
const endpoint = (deviceId: string, generation = 1) => new RelayEndpoint({ ...ids, deviceId, generation, keyId: `${deviceId}_k${generation}` });
const rejected = (e: unknown) => e instanceof RelayTransportError && e.code === "forbidden" && e.outcome === "rejected";
const command = (from: RelayEndpoint, to: DevicePin, sequence: number, messageId: string) => {
  const now = Date.now();
  return from.seal(to, { messageId, sequence, type: "command", createdAt: now, expiresAt: now + 600_000 }, Buffer.from(JSON.stringify({ synthetic: messageId })));
};
const poll = (net: PinnedRelayTransport, who: RelayEndpoint) => net.poll(who.poll({ requestId: randomUUID(), issuedAt: Date.now(), after: 0, limit: 10 }));
const messages = async (net: PinnedRelayTransport, who: RelayEndpoint) => (await poll(net, who)).deliveries.map(d => d.envelope.messageId).sort();
type Rows = { pins: Array<Record<string, unknown>>; receipts: Array<Record<string, unknown>> };
function snapshot(dir: string): Rows {
  const db = new DatabaseSync(join(dir, "relay.sqlite"), { readOnly: true });
  try { return { pins: db.prepare("SELECT device,generation,key_id,revoked FROM pins ORDER BY device").all(), receipts: db.prepare("SELECT message_id,sender,state FROM receipts ORDER BY message_id").all() }; }
  finally { db.close(); }
}
const stopped = async (svc: { stop(): Promise<{ code: number | null; events: string[] }> }) => { const r = await svc.stop(); assert.equal(r.code, 0); assert.deepEqual(r.events, ["listening", "closed"]); };
function noKeyMaterial(root: string): void {
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (!/sqlite|-wal|-shm|-journal/.test(n)) assert.doesNotMatch(readFileSync(p, "utf8"), /PRIVATE KEY|BEGIN CERTIFICATE/, n); } };
  walk(root);
}

test("explicit revokedDevices: the old sender is refused at ingress/poll/ACK, tombstone persists, restarts are idempotent", { timeout: 120_000 }, async t => {
  const p = lab(t, "rv-"), data = join(p, "relay"), tls = memoryTLS();
  const recipient = endpoint("relay_host"), old = endpoint("old_sender"), keep = endpoint("keep_sender"), fresh = endpoint("fresh_sender");
  const config = (extra: Record<string, unknown>) => ({ dataDir: data, ownerId: ids.ownerId, installationId: ids.installationId, ...extra });

  // Before the control: the old sender is a valid pinned sender (the recovery restart alone never revoked it remotely).
  let svc = await startService(t, p, tls, config({ pins: [recipient.publicPin, old.publicPin, keep.publicPin] }));
  let net = svc.transport(); defer(t, () => net.close());
  const a1 = command(old, recipient.publicPin, 1, "msg_old_1"), a2 = command(old, recipient.publicPin, 2, "msg_old_2"), k1 = command(keep, recipient.publicPin, 1, "msg_keep_1");
  await net.enqueue(a1); await net.enqueue(a2); await net.enqueue(k1);
  assert.deepEqual(await messages(net, recipient), ["msg_keep_1", "msg_old_1", "msg_old_2"], "before: old sender accepted and deliverable");
  await net.poll(old.poll({ requestId: randomUUID(), issuedAt: Date.now(), after: 0, limit: 1 }));
  await net.close(); await stopped(svc);

  // Recovery-style restart with only the new public pins (old sender OMITTED) plus the EXPLICIT owner decision.
  const revoking = config({ pins: [recipient.publicPin, keep.publicPin, fresh.publicPin], revokedDevices: ["old_sender"] });
  svc = await startService(t, p, tls, revoking); net = svc.transport();
  await assert.rejects(net.enqueue(command(old, recipient.publicPin, 3, "msg_old_3")), rejected, "old sender enqueue refused at ingress");
  await assert.rejects(net.enqueue(a1), rejected, "duplicate replay of the old signed envelope refused");
  await assert.rejects(net.poll(old.poll({ requestId: randomUUID(), issuedAt: Date.now(), after: 0, limit: 1 })), rejected, "old sender poll refused");
  await assert.rejects(net.ack(old.ack({ requestId: randomUUID(), issuedAt: Date.now(), messages: [{ messageId: "msg_old_1", receiptId: randomUUID() }] })), rejected, "old sender ACK refused");
  assert.deepEqual(await messages(net, recipient), ["msg_keep_1"], "pending old receipts are stale: never delivered, never executable");
  await net.enqueue(command(fresh, recipient.publicPin, 1, "msg_fresh_1"));
  await net.enqueue(command(keep, recipient.publicPin, 2, "msg_keep_2"));
  assert.deepEqual(await messages(net, recipient), ["msg_fresh_1", "msg_keep_1", "msg_keep_2"], "independent senders keep working");
  await net.close(); await stopped(svc);
  const first = snapshot(data);
  assert.deepEqual(first.pins.map(r => [r.device, r.revoked]), [["fresh_sender", 0], ["keep_sender", 0], ["old_sender", 1], ["relay_host", 0]]);
  assert.deepEqual(first.receipts.filter(r => r.sender === "old_sender").map(r => r.state), ["stale", "stale"]);

  // Same config again: idempotent, nothing changes in the durable pin/receipt state.
  svc = await startService(t, p, tls, revoking); net = svc.transport();
  await assert.rejects(net.enqueue(command(old, recipient.publicPin, 4, "msg_old_4")), rejected);
  await net.close(); await stopped(svc);
  assert.deepEqual(snapshot(data), first, "repeat is idempotent");

  // Removing the list (old pin still omitted) never reactivates: the tombstone lives in the store, not the config.
  svc = await startService(t, p, tls, config({ pins: [recipient.publicPin, keep.publicPin, fresh.publicPin] })); net = svc.transport();
  await assert.rejects(net.enqueue(command(old, recipient.publicPin, 5, "msg_old_5")), rejected, "omission alone does not restore");
  assert.deepEqual(await messages(net, recipient), ["msg_fresh_1", "msg_keep_1", "msg_keep_2"]);
  await net.close(); await stopped(svc);
  assert.deepEqual(snapshot(data), first);

  // Listing the old same-generation pin again (revocation list removed) fails closed before the listener; the store is released.
  const relisted = await refusedService(t, p, tls, config({ pins: [recipient.publicPin, old.publicPin, keep.publicPin, fresh.publicPin] }));
  assert.deepEqual([relisted.code, relisted.stdout, relisted.error], [1, "", "conflict"], "old pin cannot silently restore the sender");
  assert.deepEqual(snapshot(data), first);

  // Deliberate next generation follows the real RelayStore policy and is distinct from the stale gen-1 history.
  const old2 = endpoint("old_sender", 2);
  const overlap = await refusedService(t, p, tls, config({ pins: [recipient.publicPin, old2.publicPin], revokedDevices: ["old_sender"] }));
  assert.deepEqual([overlap.code, overlap.stdout, overlap.error], [1, "", "config_invalid"], "a pinned ID cannot also be revoked");
  svc = await startService(t, p, tls, config({ pins: [recipient.publicPin, keep.publicPin, fresh.publicPin, old2.publicPin] })); net = svc.transport();
  await net.enqueue(command(old2, recipient.publicPin, 1, "msg_old_g2"));
  await assert.rejects(net.enqueue(command(old, recipient.publicPin, 6, "msg_old_6")), (e: unknown) => e instanceof RelayTransportError && e.outcome === "rejected", "generation 1 stays refused");
  assert.deepEqual(await messages(net, recipient), ["msg_fresh_1", "msg_keep_1", "msg_keep_2", "msg_old_g2"], "stale gen-1 receipts never return");
  await net.close(); await stopped(svc);
  noKeyMaterial(p);
});

test("invalid revokedDevices is refused before any file, store or listener; unknown IDs fail closed and release the store", { timeout: 120_000 }, async t => {
  const p = lab(t, "rx-"), data = join(p, "relay"), tls = memoryTLS();
  const recipient = endpoint("relay_host"), old = endpoint("old_sender");
  const config = (extra: Record<string, unknown>) => ({ dataDir: data, ownerId: ids.ownerId, installationId: ids.installationId, ...extra });
  const pins = [recipient.publicPin, old.publicPin];
  const bad: Array<[string, unknown]> = [["string", "old_sender"], ["object", { 0: "old_sender" }], ["null", null], ["number entry", [7]], ["null entry", [null]], ["nested", [["old_sender"]]],
    ["empty id", [""]], ["space", ["bad id"]], ["path", ["../x"]], ["long id", ["a".repeat(81)]], ["duplicate", ["ghost", "ghost"]], ["too many", Array.from({ length: 65 }, (_, i) => `d${i}`)]];
  for (const [name, value] of bad) {
    const r = await refusedService(t, p, tls, config({ pins, revokedDevices: value }));
    assert.deepEqual([r.code, r.stdout, r.error], [1, "", "config_invalid"], name);
  }
  const unknownKey = await refusedService(t, p, tls, config({ pins, revokedDevice: ["old_sender"] }));
  assert.equal(unknownKey.error, "config_invalid");
  const overlapped = await refusedService(t, p, tls, config({ pins, revokedDevices: ["old_sender"] }));
  assert.equal(overlapped.error, "config_invalid");
  assert.equal(existsSync(data), false, "nothing above reached a store: the data directory was never created");

  // 64 exact IDs is the bound; an unknown ID is refused fail-closed (nothing guessed or created) and the store is closed.
  const unknown = await refusedService(t, p, tls, config({ pins, revokedDevices: ["ghost_device"] }));
  assert.deepEqual([unknown.code, unknown.stdout, unknown.error], [1, "", "revocation_unknown"]);
  assert.deepEqual(snapshot(data).pins.map(r => [r.device, r.revoked]), [["old_sender", 0], ["relay_host", 0]], "no device invented or revoked");
  // Earlier valid entries stay applied (only narrows authority); the unknown one still refuses the startup.
  const partial = await refusedService(t, p, tls, config({ pins: [recipient.publicPin], revokedDevices: ["old_sender", "ghost_device"] }));
  assert.equal(partial.error, "revocation_unknown");
  assert.deepEqual(snapshot(data).pins.map(r => [r.device, r.revoked]), [["old_sender", 1], ["relay_host", 0]]);
  // Rollback closed the store: the same directory starts cleanly right away, and 64 IDs besides an empty list are accepted.
  const ok = await startService(t, p, tls, config({ pins: [recipient.publicPin], revokedDevices: [] })); await stopped(ok);
  const sixtyFour = Array.from({ length: 64 }, (_, i) => `d${i}`);
  const full = await refusedService(t, p, tls, config({ pins: [recipient.publicPin], revokedDevices: sixtyFour }));
  assert.equal(full.error, "revocation_unknown", "64 entries pass validation and meet the store policy");
  noKeyMaterial(p);
});

test("the distributed bin.js keeps default private TLS files strict and validates revokedDevices before reading them", { timeout: 60_000 }, async t => {
  const p = lab(t, "rb-"), bin = new URL("../../packages/relay-service/dist/bin.js", import.meta.url).pathname;
  const run = (revoked: unknown) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const config = join(p, `bin-${Math.random().toString(36).slice(2)}.json`);
    // Public inert sentinels: the TLS file paths do not exist, no key or certificate is ever written.
    writeFileSync(config, JSON.stringify({ version: 1, dataDir: join(p, "d"), ownerId: ids.ownerId, installationId: ids.installationId, host: "127.0.0.1", port: 0,
      tlsKeyFile: join(p, "absent.key"), tlsCertFile: join(p, "absent.crt"), ...(revoked === undefined ? {} : { revokedDevices: revoked }) }), { mode: 0o600 });
    const child = spawn(process.execPath, [bin, "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += String(b); }); child.stderr.on("data", b => { stderr += String(b); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000); defer(t, () => child.kill("SIGKILL"));
    child.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  for (const value of [["dup", "dup"], "x", [1]]) { const r = await run(value); assert.deepEqual([r.code, r.stdout, JSON.parse(r.stderr)], [1, "", { error: "config_invalid" }]); }
  for (const value of [undefined, [], ["valid_id"]]) { const r = await run(value); assert.deepEqual([r.code, r.stdout, JSON.parse(r.stderr)], [1, "", { error: "tls_file_untrusted" }], "default path still requires private TLS files"); }
  assert.equal(existsSync(join(p, "d")), false);
});
