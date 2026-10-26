import assert from "node:assert/strict";
import { createPublicKey, createSecretKey, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createHostApp } from "@dexter/hub/http";
import { OwnerPairingClaimsListSchema, OwnerPairingDecisionRecordSchema, OwnerPairingOfferResultSchema, OwnerPairingStatusSchema,
  OWNER_PAIRING_HISTORICAL_SCOPES, type OwnerPairingClaim, type OwnerPairingStatus } from "@dexter/contracts";
import { AuthorityCoordinator, LocalAuthorityController, type SnapshotKey } from "@dexter/operations";
import { HostServices } from "../packages/cli/src/host-services.js";
import { OWNER_PAIRING_OFFERS_DATABASE_FILE } from "../packages/cli/src/owner-pairing-journal.js";
import { call, clientIdentity, hostIdentity, type Trust } from "./app-client-lab.js";
import type { TlsIdentity } from "@dexter/devices";

// The owner pairing journal is excluded from authority checkpoints and could be lost. A request formed before a checkpoint
// restore/activation (same installation and owner) or before a journal loss must never be accepted as NEW: no new offer,
// code or decision. Real HostServices + real mTLS listener + real checkpoint/activation (synthetic owner key, snapshot key,
// coordinator and TLS identities in private temp dirs; no account, Keychain, TCC, SSH or product port).
const HISTORICAL = [...OWNER_PAIRING_HISTORICAL_SCOPES];
type Reply = { status: number; json: Record<string, unknown> };
interface Base { dataDir: string; services: HostServices; trust: Trust; api(method: string, path: string, body?: unknown): Promise<Reply> }

function workspace(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-owner-restore-"))); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function openBase(t: TestContext, dataDir: string, host: TlsIdentity): Promise<Base> {
  const services = new HostServices({ dataDir, appClients: { identity: host } });
  const trust = { url: await services.startAppClients(), certPem: host.certPem, fingerprint: host.fingerprint };
  const app = createHostApp(services.store, { ownerPairingOffers: services.ownerPairingOffersHttp });
  t.after(async () => { await services.shutdown(); });
  return { dataDir, services, trust, api: async (method, path, body) => {
    const r = await app.request("http://127.0.0.1" + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await r.text(); return { status: r.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
  } };
}
const status = async (b: Base): Promise<OwnerPairingStatus> => OwnerPairingStatusSchema.parse((await b.api("GET", "/v1/owner/app-client-pairing/status")).json);
const createBody = (s: OwnerPairingStatus, role: "client-ios" | "client-mac" = "client-mac") => ({ expectedHostId: s.hostId, expectedRevision: s.revision,
  expectedJournalPin: s.journalPin!, clientRequestId: randomUUID(), role, scopes: HISTORICAL, ttlSeconds: 300 });
const offers = (dataDir: string): number => { const db = new DatabaseSync(join(dataDir, "app-clients.sqlite"), { readOnly: true });
  try { return Number((db.prepare("SELECT COUNT(*) AS n FROM offers").get() as { n: number }).n); } finally { db.close(); } };
const claimsList = async (b: Base) => OwnerPairingClaimsListSchema.parse((await b.api("GET", "/v1/owner/app-client-pairing/claims")).json);
const decisionBody = (list: { hostId: string; revision: number; journalPin: string | null }, claim: OwnerPairingClaim, decision = "approve") => ({
  expectedHostId: list.hostId, expectedRevision: list.revision, expectedJournalPin: list.journalPin!, clientRequestId: randomUUID(), decision,
  expectedClaimPin: claim.claimPin, expectedClientFingerprint: claim.clientFingerprint });
/** Owner invitation + the other device's real mTLS claim with it. */
async function claimWith(b: Base, device: TlsIdentity): Promise<void> {
  const made = OwnerPairingOfferResultSchema.parse((await b.api("POST", "/v1/owner/app-client-pairing/offers", createBody(await status(b)))).json);
  const bundle = JSON.parse(made.invitation!.text) as { offerId: string; code: string };
  assert.equal((await call(b.trust, device, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Mac sintético" })).status, 200);
}
function custody(): { owner: { publicKey: KeyObject; sign(message: Buffer): Buffer }; key: SnapshotKey } {
  const { privateKey } = generateKeyPairSync("ed25519"), secret = createSecretKey(randomBytes(32));
  return { owner: { publicKey: createPublicKey(privateKey), sign: (message: Buffer) => sign(null, message, privateKey) }, key: { keyId: "owner-restore-lab", use: operation => operation(secret) } };
}

test("checkpoint + authority activation (same installation/owner): requests formed before are refused, never re-executed; fresh ones work", async (t) => {
  const root = workspace(t), host = hostIdentity(join(root, "id-host"));
  const source = await openBase(t, join(root, "source"), host);
  const before = await status(source);
  // A create whose ACK was "lost" (receipt only in the source journal), a cancel and a decision formed but never sent.
  const lostCreate = createBody(before);
  const first = OwnerPairingOfferResultSchema.parse((await source.api("POST", "/v1/owner/app-client-pairing/offers", lostCreate)).json);
  assert.equal(first.record.receipt.outcome, "created");
  await claimWith(source, clientIdentity(join(root, "id-mac")));
  const shownList = await claimsList(source), shownClaim = shownList.items[0]!;
  const unsentDecision = decisionBody(shownList, shownClaim);
  const afterCreate = await status(source);
  const unsentCancel = { expectedHostId: afterCreate.hostId, expectedRevision: afterCreate.revision, expectedJournalPin: afterCreate.journalPin!, clientRequestId: randomUUID() };
  const offersBefore = offers(source.dataDir);
  // Real checkpoint + activation into a new directory: same installation and owner, authority epoch moves, journal excluded.
  const { owner, key } = custody(), destination = join(root, "destination"), artifact = join(root, "checkpoint.dxg8");
  const coordinator = AuthorityCoordinator.open(join(root, "coordinator"), { ownerId: source.services.store.ownerId, ownerPublicKey: owner.publicKey });
  t.after(() => coordinator.close());
  const controller = new LocalAuthorityController({ coordinator });
  const hold = await controller.quiesce(source.services);
  const prepared = controller.prepare(hold, { key, output: artifact });
  await source.services.shutdown();
  controller.revokeSource({ dataDir: source.dataDir }, prepared.checkpointId, destination);
  controller.activate({ artifact, key, receipt: controller.issueReceipt(owner, prepared.checkpointId, 60_000) });
  const restored = await openBase(t, destination, host);
  const authority = restored.services.store.authorityStatus();
  assert.equal(authority.installationId, before.hostId); assert.equal(authority.ownerId, source.services.store.ownerId); assert.equal(authority.epoch, 2);
  assert.equal(offers(destination), offersBefore, "the registry (offers, claim) was transferred");
  const now = await status(restored);
  assert.equal(now.hostId, before.hostId); assert.equal(now.revision, 1, "the excluded journal restarts at revision 1");
  assert.notEqual(now.journalPin, before.journalPin, "a restore/activation changes the journal pin");
  // The lost-ACK create (same id, same body, revision 1 matches again) is refused: no new offer, no new code.
  const PIN_REFUSAL = "Owner pairing journal changed; re-read the status before deciding again.";
  const retried = await restored.api("POST", "/v1/owner/app-client-pairing/offers", lostCreate);
  assert.equal(retried.status, 409); assert.equal(retried.json.message, PIN_REFUSAL, "refused by the journal pin"); assert.equal(retried.json.invitation, undefined);
  assert.equal(offers(destination), offersBefore, "no new offer or code");
  assert.equal((await restored.api("GET", `/v1/owner/app-client-pairing/receipts/${lostCreate.clientRequestId}`)).status, 404, "receipt absent here: unconfirmed, never re-issued");
  // The cancel and the decision formed before the restore are refused by the pin too (nothing reserved, nothing applied).
  const cancel = await restored.api("POST", `/v1/owner/app-client-pairing/offers/${first.record.receipt.offer!.offerId}/cancel`, unsentCancel);
  assert.equal(cancel.status, 409); assert.equal(cancel.json.message, PIN_REFUSAL);
  const decision = await restored.api("POST", `/v1/owner/app-client-pairing/claims/${shownClaim.claimId}/decision`, unsentDecision);
  assert.equal(decision.status, 409); assert.equal(decision.json.message, PIN_REFUSAL);
  assert.equal((await status(restored)).revision, 1); assert.equal((await claimsList(restored)).revision, 1, "refusals reserved nothing");
  // The activation itself closed the pairing that was open at the source (its offer cancelled, its claim rejected).
  const transferred = (await restored.api("GET", `/v1/owner/app-client-pairing/claims/${shownClaim.claimId}`)).json as { status: string; approvedDeviceId: string | null };
  assert.equal(transferred.status, "rejected"); assert.equal(transferred.approvedDeviceId, null);
  // Fresh owner gestures with the new pin work (the destination is fully usable).
  await claimWith(restored, clientIdentity(join(root, "id-mac-2")));
  const restoredList = await claimsList(restored);
  assert.equal(restoredList.journalPin, now.journalPin); assert.equal(restoredList.items.length, 1);
  const decided = OwnerPairingDecisionRecordSchema.parse((await restored.api("POST", `/v1/owner/app-client-pairing/claims/${restoredList.items[0]!.claimId}/decision`,
    decisionBody(restoredList, restoredList.items[0]!))).json);
  assert.equal(decided.receipt.outcome, "approved"); assert.equal(decided.receipt.grantsCreated, 0);
  assert.equal(offers(destination), offersBefore + 1, "exactly the one fresh invitation");
});

test("in-place journal loss: a request formed before is refused; restart with the journal kept replays the original receipt", async (t) => {
  const root = workspace(t), host = hostIdentity(join(root, "id-host")), dataDir = join(root, "host");
  let base = await openBase(t, dataDir, host);
  const s1 = await status(base);
  const request = createBody(s1);
  const first = OwnerPairingOfferResultSchema.parse((await base.api("POST", "/v1/owner/app-client-pairing/offers", request)).json);
  // Restart, journal kept: same pin; the exact retry returns the original receipt and never a new code.
  await base.services.shutdown();
  base = await openBase(t, dataDir, host);
  const s2 = await status(base);
  assert.equal(s2.journalPin, s1.journalPin, "restart keeps continuity");
  const replay = await base.api("POST", "/v1/owner/app-client-pairing/offers", request);
  assert.equal(replay.status, 200);
  const replayed = OwnerPairingOfferResultSchema.parse(replay.json);
  assert.deepEqual(replayed.record.receipt, first.record.receipt); assert.equal(replayed.invitation, null, "the code is never re-issued after a restart");
  assert.equal(offers(dataDir), 1);
  // A claim decision formed now, then the journal is lost in place (same authority epoch).
  await claimWith(base, clientIdentity(join(root, "id-mac")));
  const list = await claimsList(base), claim = list.items[0]!, decision = decisionBody(list, claim);
  const offersBefore = offers(dataDir);
  await base.services.shutdown();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE + suffix), { force: true });
  base = await openBase(t, dataDir, host);
  const s3 = await status(base);
  assert.equal(base.services.store.authorityStatus().epoch, 1, "same authority generation");
  assert.notEqual(s3.journalPin, s1.journalPin, "a recreated journal is another instance");
  assert.equal(s3.revision, 1);
  const lost = await base.api("POST", "/v1/owner/app-client-pairing/offers", request);
  assert.equal(lost.status, 409); assert.equal(lost.json.message, "Owner pairing journal changed; re-read the status before deciding again.");
  assert.equal(offers(dataDir), offersBefore, "no new offer or code");
  const lostDecision = await base.api("POST", `/v1/owner/app-client-pairing/claims/${claim.claimId}/decision`, decision);
  assert.equal(lostDecision.status, 409); assert.equal(lostDecision.json.message, "Owner pairing journal changed; re-read the status before deciding again.");
  assert.equal((await claimsList(base)).items[0]?.status, "pending", "the decision formed before the loss had no effect");
  // Missing, malformed or guessed pins never pass.
  const { expectedJournalPin: _omit, ...withoutPin } = createBody(s3);
  assert.equal((await base.api("POST", "/v1/owner/app-client-pairing/offers", withoutPin)).status, 400);
  assert.equal((await base.api("POST", "/v1/owner/app-client-pairing/offers", { ...createBody(s3), expectedJournalPin: "x" })).status, 400);
  assert.equal((await base.api("POST", "/v1/owner/app-client-pairing/offers", { ...createBody(s3), expectedJournalPin: "f".repeat(64) })).status, 409);
  assert.equal(offers(dataDir), offersBefore); assert.equal((await status(base)).revision, 1, "refusals reserved nothing");
});
