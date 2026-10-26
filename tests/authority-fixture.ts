// Shared fixture of the G8 authority tests (also loaded by the child processes). Everything is synthetic, private
// (0700/0600) and built with the real Root stores; only the relay-host associations file is written directly with the
// frozen public SQL, because this package never imports relay-host.
import { createHash, createPrivateKey, createPublicKey, createSecretKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agenda } from "@dexter/agenda";
import { ContextHost, FixtureMemoryAdapter } from "@dexter/context";
import { ClientPairingRegistry, DEVICE_OPERATIONS, DevicePairingRegistry, deviceOperationSchemaHash, operationFor } from "@dexter/devices";
import { HostStore } from "@dexter/hub";
import type { CustodyProvider, OperationPin, OwnerAuthority, SnapshotKey } from "@dexter/operations";
import { DeviceTurnSurface, type DevicePinSnapshot, type DeviceToolsPort } from "../packages/cli/src/device-turn-surface.js";
import type { HostPort } from "@dexter/relay-consumer";

// The real Root relay consumer journal (not re-exported by the package), loaded from this lab's own build.
interface JournalLike {
  prepare(value: object, messageId: string, receiptId: string, issuer: string, provenance: string): unknown;
  state(deviceId: string, operationId: string, state: string, turnId: string | null): void;
  rememberAck(messageId: string, receiptId: string, request: unknown): void;
  close(): void;
}
const { ConsumerJournal } = await import(new URL("../../packages/relay-consumer/dist/journal.js", import.meta.url).href) as {
  ConsumerJournal: new (host: HostPort, directory: string) => JournalLike;
};

export const LEASE_SENTINEL = "nativeCursorAuthoritySentinel_XYZ987";
export const RELAY_ASSOCIATIONS_SQL = `CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),host_id TEXT NOT NULL,owner_id TEXT NOT NULL,host_revision INTEGER NOT NULL,recipient_json TEXT NOT NULL);
CREATE TABLE associations(device_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','revoked')),binding_json TEXT NOT NULL,sender_json TEXT NOT NULL,host_revision INTEGER NOT NULL);
CREATE TABLE history(device_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL CHECK(action IN ('enroll','revoke','recipient')),binding_json TEXT NOT NULL,sender_json TEXT NOT NULL,host_revision INTEGER NOT NULL,PRIMARY KEY(device_id,revision));
CREATE TABLE pins(device_id TEXT NOT NULL,generation INTEGER NOT NULL,key_id TEXT NOT NULL UNIQUE,signing_key TEXT NOT NULL UNIQUE,encryption_key TEXT NOT NULL UNIQUE,pin_json TEXT NOT NULL,PRIMARY KEY(device_id,generation));`;

/** Synthetic in-memory custody: keys are generated per test and never exported to a file. */
export interface TestCustody { provider: CustodyProvider; owner: OwnerAuthority; key: SnapshotKey; wire: { ownerPkcs8: string; secret: string; keyId: string } }
export function custodyFromWire(wire: { ownerPkcs8: string; secret: string; keyId: string }): TestCustody {
  const privateKey = createPrivateKey({ key: Buffer.from(wire.ownerPkcs8, "base64"), format: "der", type: "pkcs8" });
  const owner: OwnerAuthority = { publicKey: createPublicKey(privateKey), sign: (message) => sign(null, message, privateKey) };
  const secret: KeyObject = createSecretKey(Buffer.from(wire.secret, "base64"));
  const key: SnapshotKey = { keyId: wire.keyId, use: (operation) => operation(secret) };
  return { owner, key, wire, provider: { snapshotKey: () => key, ownerSigner: () => owner } };
}
export function newCustody(keyId = "g8-test-key"): TestCustody {
  const { privateKey } = generateKeyPairSync("ed25519");
  return custodyFromWire({ ownerPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), secret: randomBytes(32).toString("base64"), keyId });
}

export interface Seeded {
  hostId: string; ownerId: string; botId: string; threadId: string;
  awaitingActionId: string; runningActionId: string; runningTurnId: string; queuedTurnId: string; completedTurnId: string;
  relayTurnId: string; relayHash: string; clientDeviceId: string; artifactId: string; occurrenceRequestId: string;
}
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * A rich installation: Hub (bots, threads, messages, completed/running/queued turns with a native cursor, an approval
 * awaiting the owner, a claimed action, a Hub device, grants), Context (artifact revisions, fork, skill, memory, Git),
 * Agenda (prepared occurrence), device registry (open offer), app clients (approved binding, open offer, pending
 * claim), relay consumer journal under relay-host/ (committed/unknown/prepared operations, retained ACK request) and
 * relay-host associations (active and revoked/tombstoned association, pins, history). All stores are closed on return.
 * The running turn and the claimed action are left `running`: the next writer open marks them `unknown`.
 */
export function seedInstallation(dataDir: string, ownerId?: string): Seeded {
  const store = new HostStore(ownerId === undefined ? { dataDir } : { dataDir, ownerId });
  const context = new ContextHost(store, new FixtureMemoryAdapter([]));
  const agenda = new Agenda(store);
  const devices = new DevicePairingRegistry(store);
  const clients = new ClientPairingRegistry(store);
  const port = {
    hostId: store.hostId, ownerId: store.ownerId, withWriterLease: <T>(work: () => T): T => store.withWriterLease(work),
  } as unknown as HostPort;
  const journal = new ConsumerJournal(port, join(dataDir, "relay-host"));
  try {
    const bot = store.createBot({ name: "Synthetic", profileId: "personal", engine: "claude" });
    const thread = store.createThread(bot.id);
    // Prepare through the current host mutation receipts while the thread is settled. The later seeded
    // in-flight actions must defer this occurrence; they cannot authorize another automation run.
    const scheduleReceipt = agenda.createAutomation({ hostId: store.hostId, clientRequestId: "fixture-agenda-create", expectedRevision: 0,
      botId: bot.id, threadId: thread.id, title: "Synthetic reminder", content: "synthetic reminder", when: { kind: "once", at: store.now() + 60_000 } });
    const runReceipt = agenda.runAutomation(scheduleReceipt.scheduleId, { hostId: store.hostId, clientRequestId: "fixture-agenda-run", expectedRevision: scheduleReceipt.revision });
    assert.ok(runReceipt.occurrence);
    assert.equal(runReceipt.occurrence.state, "prepared");
    const occurrenceRequestId = runReceipt.occurrence.clientRequestId;
    store.appendMessage(thread.id, { clientMessageId: "m1", content: "synthetic message one" });
    store.appendMessage(thread.id, { clientMessageId: "m2", content: "synthetic message two" });
    const completed = store.createTurn(thread.id, { clientRequestId: "turn-done", content: "synthetic done" }).turn;
    store.claimNextTurn(thread.id);
    store.finishTurn(completed.id, "completed", null, LEASE_SENTINEL);
    const running = store.createTurn(thread.id, { clientRequestId: "turn-running", content: "synthetic running" }).turn;
    store.claimNextTurn(thread.id);
    const queued = store.createTurn(thread.id, { clientRequestId: "turn-queued", content: "synthetic queued" }).turn;
    const relayHash = sha("synthetic relay logical operation");
    const relayTurn = store.createTurn(thread.id, { clientRequestId: "relay-request-1", content: "synthetic relay" }, relayHash).turn;
    store.setGrant({ botId: bot.id, tool: "fixture.ask", destination: "dest_ask", policy: "ask" });
    const awaiting = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "fixture.ask", destination: "dest_ask", arguments: { note: "synthetic" }, idempotencyKey: "act-ask" });
    store.setGrant({ botId: bot.id, tool: "fixture.run", destination: "dest_run", policy: "allow" });
    const ready = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "fixture.run", destination: "dest_run", arguments: { note: "synthetic" }, idempotencyKey: "act-run" });
    store.claimAction(ready.id);
    store.registerDevice({ name: "Synthetic Mac", platform: "macos", capabilities: ["fixture.run"] });

    const token = context.issue(running.id);
    const artifact = context.createArtifact(token, "# Synthetic artifact r1\n", "fixture");
    context.reviseArtifact(token, artifact.id, 1, "# Synthetic artifact r2\n", "fixture");
    context.forkArtifact(token, artifact.id, 1);
    context.activateSkill({ kind: "global" }, context.registerSkill("synthetic_skill", "1.0.0", "# Synthetic skill\n"));
    context.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "# Memória sintética\n", origin: "fixture", classification: "context" });

    devices.createOffer({ kind: "pair" });
    const paired = clients.createOffer({ kind: "pair", role: "client-ios", scopes: ["chat.read", "chat.write"] });
    const claim = clients.claim({ offerId: paired.offerId, code: paired.code, name: "Synthetic Phone", clientFingerprint: "c".repeat(64) });
    const approved = clients.approveClaim(claim.claimId);
    // A second app client paired, approved and then revoked: its tombstoned binding and revoked pins must survive.
    const retired = clients.createOffer({ kind: "pair", role: "client-mac", scopes: ["chat.read"] });
    clients.revokeDevice(clients.approveClaim(clients.claim({ offerId: retired.offerId, code: retired.code, name: "Retired Mac", clientFingerprint: "e".repeat(64) }).claimId).deviceId);
    const pending = clients.createOffer({ kind: "pair", role: "client-mac", scopes: ["chat.read"] });
    clients.claim({ offerId: pending.offerId, code: pending.code, name: "Pending Mac", clientFingerprint: "d".repeat(64) });
    clients.createOffer({ kind: "pair", role: "client-ios", scopes: ["chat.read"] });

    const provenance = JSON.stringify(["synthetic-issuer"]);
    const issuer = sha(provenance);
    const entry = (operationId: string, hash: string, requestId: string, state: "prepared" | "committed" | "unknown", turnId: string | null) =>
      ({ deviceId: approved.deviceId, operationId, hash, threadId: thread.id, requestId, issuerHash: issuer, state, turnId });
    journal.prepare(entry("op-committed", relayHash, "relay-request-1", "prepared", null), "msg-1", "rcpt-1", issuer, provenance);
    journal.state(approved.deviceId, "op-committed", "committed", relayTurn.id);
    journal.rememberAck("msg-1", "rcpt-1", { synthetic: "retained ack request" });
    journal.prepare(entry("op-unknown", sha("unknown op"), "relay-request-2", "prepared", null), "msg-2", "rcpt-2", issuer, provenance);
    journal.state(approved.deviceId, "op-unknown", "unknown", null);
    journal.prepare(entry("op-prepared", sha("prepared op"), "relay-request-3", "prepared", null), "msg-3", "rcpt-3", issuer, provenance);

    writeRelayAssociations(join(dataDir, "relay-host"), store.hostId, store.ownerId);
    return {
      hostId: store.hostId, ownerId: store.ownerId, botId: bot.id, threadId: thread.id, awaitingActionId: awaiting.id, runningActionId: ready.id,
      runningTurnId: running.id, queuedTurnId: queued.id, completedTurnId: completed.id, relayTurnId: relayTurn.id, relayHash,
      clientDeviceId: approved.deviceId, artifactId: artifact.id, occurrenceRequestId,
    };
  } finally {
    journal.close(); clients.close(); devices.close(); agenda.close(); context.close(); store.close();
  }
}

/** Public relay-host association metadata with an active association, a revoked tombstone, history and pins. */
export function writeRelayAssociations(directory: string, hostId: string, ownerId: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "relay-associations.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(RELAY_ASSOCIATIONS_SQL);
    // Full public-only version-1 pins: recipient rotation archives generations 1 and 2; each
    // sender has its own Ed25519/X25519 SPKI. Private key objects remain in memory and are never exported.
    const pin = (deviceId: string, generation: number, keyId: string) => ({
      installationId: hostId, ownerId, deviceId, generation, keyId,
      signingPublicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      encryptionPublicKey: generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    });
    const recipient1 = pin("dev_assoc_recipient", 1, "recipient-1"), recipient2 = pin("dev_assoc_recipient", 2, "recipient-2");
    const active = pin("dev_assoc_active", 1, "kid-1"), revoked = pin("dev_assoc_revoked", 1, "kid-2");
    db.prepare("INSERT INTO metadata VALUES (1, 1, ?, ?, 2, ?)").run(hostId, ownerId, JSON.stringify(recipient2));
    // Relay association revoke retains the enrolled binding snapshot and sender, unlike app binding revocation.
    const binding = (deviceId: string): string => JSON.stringify({ installationId: hostId, ownerId, deviceId,
      role: "client-ios", scopes: ["chat.read", "chat.write"], fingerprint: sha(`synthetic-relay-cert-${deviceId}`),
      generation: 1, revision: 1, status: "active" });
    const activeBinding = binding(active.deviceId), revokedBinding = binding(revoked.deviceId);
    const activeSender = JSON.stringify(active), revokedSender = JSON.stringify(revoked);
    // Revoked before the host's recipient rotation: its enrollment host revision remains 1.
    // Active is enrolled after rotation under the current host revision 2, with sender generation independent.
    db.prepare("INSERT INTO associations VALUES (?, 1, 'active', ?, ?, 2)").run(active.deviceId, activeBinding, activeSender);
    db.prepare("INSERT INTO associations VALUES (?, 2, 'revoked', ?, ?, 1)").run(revoked.deviceId, revokedBinding, revokedSender);
    db.prepare("INSERT INTO history VALUES (?, 1, 'enroll', ?, ?, 2)").run(active.deviceId, activeBinding, activeSender);
    db.prepare("INSERT INTO history VALUES (?, 1, 'enroll', ?, ?, 1)").run(revoked.deviceId, revokedBinding, revokedSender);
    db.prepare("INSERT INTO history VALUES (?, 2, 'revoke', ?, ?, 1)").run(revoked.deviceId, revokedBinding, revokedSender);
    for (const p of [recipient1, recipient2, active, revoked]) {
      db.prepare("INSERT INTO pins VALUES (?, ?, ?, ?, ?, ?)").run(p.deviceId, p.generation, p.keyId, p.signingPublicKey, p.encryptionPublicKey, JSON.stringify(p));
    }
  } finally { db.close(); }
  chmodSync(path, 0o600);
}

// ---- device surface ---------------------------------------------------------------------------------------------
export const SURFACE_TOOL = "mac.file.append";
const SURFACE_ARGS = { name: "fixture.txt", line: "synthetic line" };
/** The trusted catalog of this build (what the operator command line uses by default). */
export const CURRENT_CATALOG: OperationPin[] = [...DEVICE_OPERATIONS.values()].map((op) => ({ tool: op.tool, version: op.version, schemaHash: op.schemaHash }));
/** A frozen OLDER release only (1.0.0 pins): a surface pinned to the current release is not covered by it. */
export const OLD_ONLY_CATALOG: OperationPin[] = [...DEVICE_OPERATIONS.values()].filter((op) => op.tool !== "mac.cua.status").map((op) => ({
  tool: op.tool, version: "1.0.0",
  schemaHash: deviceOperationSchemaHash({ version: "1.0.0", tool: op.tool, effect: op.effect, description: op.description, inputSchema: op.inputSchema }),
}));
export interface SurfaceSeed { deviceId: string; revokedDeviceId: string; routeId: string; okActionId: string; unknownActionId: string; surfaceThreadId: string }
const fp = (label: string): string => createHash("sha256").update(`synthetic-surface-cert-${label}`).digest("hex");

/**
 * Populates the real device registry and the real `DeviceTurnSurface` of an installation seeded by `seedInstallation`:
 * a paired device rotated to generation 2, a second device paired then revoked, a route and grant, a succeeded call,
 * an unknown call, a call whose Hub action committed before the surface recorded it (orphan), a durable intent with no
 * Hub action, a composite reservation and a late receipt. No provider, dispatch transport or personal data is used;
 * dispatch is the synthetic port below. All stores are closed on return.
 */
export async function seedDeviceSurface(dataDir: string, seeded: Seeded): Promise<SurfaceSeed> {
  const store = new HostStore({ dataDir });
  const registry = new DevicePairingRegistry(store);
  let outcome: "complete" | "unknown" = "complete";
  const port: DeviceToolsPort = {
    installationId: store.hostId, ownerId: store.ownerId,
    snapshot: (id) => registry.pinBinding(id) as DevicePinSnapshot | null,
    authenticatedPresence: () => "online",
    operation: (tool) => operationFor(tool),
    async dispatchBound(id, context) {
      const action = store.claimAction(id);
      const peer = registry.pinBinding(action.request.destination)!;
      if (!context.guard(action, peer)) return store.markUnknown(id, "executor_error");
      return outcome === "complete" ? store.completeAction(id, { ok: true }) : store.markUnknown(id, "executor_error");
    },
  };
  const surface = new DeviceTurnSurface(store, port);
  try {
    const pair = (label: string): string => {
      const offer = registry.createOffer({ kind: "pair" });
      const { claimId } = registry.claim({ offerId: offer.offerId, code: offer.code, clientFingerprint: fp(label), name: `Synthetic Mac ${label}`, capabilities: [SURFACE_TOOL] });
      return registry.approveClaim(claimId).deviceId;
    };
    const deviceId = pair("A");
    const rotate = registry.createOffer({ kind: "rotate", deviceId });
    registry.approveClaim(registry.claim({ offerId: rotate.offerId, code: rotate.code, clientFingerprint: fp("B"), name: "x", capabilities: [SURFACE_TOOL] }).claimId);
    const revokedDeviceId = pair("C");
    registry.revokeDevice(revokedDeviceId);
    const thread = store.createThread(seeded.botId);
    const turn = store.createTurn(thread.id, { clientRequestId: "turn-surface", content: "synthetic surface turn" }).turn;
    store.claimNextTurn(thread.id);
    const route = surface.admin.bindRoute({ botId: seeded.botId, deviceId, tool: SURFACE_TOOL });
    store.setGrant({ botId: seeded.botId, tool: SURFACE_TOOL, destination: deviceId, policy: "allow" });
    const { token } = surface.issueCapability({ turnId: turn.id });
    const call = (callId: string) => surface.call(token, { tool: SURFACE_TOOL, connectionId: route.id, callId, arguments: SURFACE_ARGS });
    const ok = await call("call-ok");
    outcome = "unknown";
    const unknown = await call("call-unknown");
    const request = store.requestAction.bind(store);
    store.requestAction = (input: unknown) => { request(input as Parameters<typeof request>[0]); throw new Error("synthetic crash after hub commit"); };
    await call("call-orphan").catch(() => undefined);
    store.requestAction = () => { throw new Error("synthetic crash before hub commit"); };
    await call("call-intent").catch(() => undefined);
    delete (store as { requestAction?: unknown }).requestAction;
    surface.reserveCompositeCall(token, { tool: SURFACE_TOOL, connectionId: route.id, callId: "call-composite", arguments: SURFACE_ARGS }, { surface: "device", listed: true });
    const okAction = store.getAction(ok.actionId);
    registry.recordLateReceipt({ actionId: okAction.id, deviceId, requestHash: okAction.requestHash, status: "completed", code: null });
    if (ok.status !== "succeeded" || unknown.status !== "unknown") throw new Error("surface fixture did not reach its states");
    return { deviceId, revokedDeviceId, routeId: route.id, okActionId: ok.actionId, unknownActionId: unknown.actionId, surfaceThreadId: thread.id };
  } finally {
    await surface.close(); registry.close(); store.close();
  }
}
