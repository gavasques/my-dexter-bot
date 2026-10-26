import assert from "node:assert/strict";
import { createHash, createSecretKey, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import { OwnerPairingClaimSchema, OwnerPairingClaimsListSchema, OwnerPairingDecisionRecordSchema, OwnerPairingOfferResultSchema, OwnerPairingRecordSchema,
  OWNER_PAIRING_HISTORICAL_SCOPES, type OwnerPairingClaim } from "@dexter/contracts";
import { captureCheckpointArtifact, doctor, openCheckpointArtifact } from "@dexter/operations";
import { HostServices } from "../packages/cli/src/host-services.js";
import { OWNER_PAIRING_OFFERS_DATABASE_FILE, OwnerPairingJournal } from "../packages/cli/src/owner-pairing-journal.js";
import { OwnerPairingClaims, ownerClaimPin, type OwnerClaimRecordSource, type OwnerPairingClaimsAdminPort } from "../packages/cli/src/owner-pairing-claims.js";
import { call, clientIdentity, hostIdentity, type Trust } from "./app-client-lab.js";
import type { TlsIdentity } from "@dexter/devices";

// Owner review of app-client claims (owner-loopback): real HostServices + real mutual-TLS app-client listener (synthetic lab
// certificates, loopback, random port) + real createHostApp/Hono. No account, Keychain, TCC, SSH, provider or product port.
const HISTORICAL = [...OWNER_PAIRING_HISTORICAL_SCOPES];
const uuid = (): string => randomUUID();
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
type Reply = { status: number; json: Record<string, unknown> };
type Api = (method: string, path: string, body?: unknown, init?: { headers?: Record<string, string>; raw?: string; env?: object }) => Promise<Reply>;
interface Lab { dataDir: string; services: HostServices; api: Api; trust: Trust | null; identity(label: string): TlsIdentity; reopen(): Promise<void>;
  devices(): number; grants(): number }

async function lab(t: TestContext, options: { appClients?: boolean } = {}): Promise<Lab> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-owner-claims-"))); chmodSync(root, 0o700);
  const host = hostIdentity(join(root, "id-host")), dataDir = join(root, "host");
  const open = () => new HostServices({ dataDir, ...(options.appClients === false ? {} : { appClients: { identity: host } }) });
  let services = open(), app = createHostApp(services.store, { ownerPairingOffers: services.ownerPairingOffersHttp, outputFiles: services.outputFilesHttp });
  let trust: Trust | null = null;
  const start = async () => { if (options.appClients !== false) trust = { url: await services.startAppClients(), certPem: host.certPem, fingerprint: host.fingerprint }; };
  await start();
  t.after(async () => { await services.shutdown(); rmSync(root, { recursive: true, force: true }); });
  let n = 0;
  const api: Api = async (method, path, body, init = {}) => {
    const headers = { ...(body !== undefined || init.raw !== undefined ? { "content-type": "application/json" } : {}), ...init.headers };
    const response = await app.request("http://127.0.0.1" + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : init.raw !== undefined ? { body: init.raw } : {}) }, init.env as never);
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
  };
  return { dataDir, get services() { return services; }, api, get trust() { return trust; }, identity: label => clientIdentity(join(root, `id-${label}-${++n}`)),
    reopen: async () => { await services.shutdown(); services = open(); app = createHostApp(services.store, { ownerPairingOffers: services.ownerPairingOffersHttp, outputFiles: services.outputFilesHttp }); await start(); },
    devices: () => services.store.listDevices().length, grants: () => services.store.summary().counts.grants } as Lab;
}
/** Owner invitation through the owner API, then the other device's real mTLS claim with it. */
async function invitedClaim(l: Lab, device: TlsIdentity, scopes: string[], role: "client-ios" | "client-mac" = "client-mac", name = "Mac sintético") {
  const status = (await l.api("GET", "/v1/owner/app-client-pairing/status")).json as { hostId: string; revision: number; journalPin: string };
  const offerRequest = uuid();
  const made = OwnerPairingOfferResultSchema.parse((await l.api("POST", "/v1/owner/app-client-pairing/offers", { expectedHostId: status.hostId,
    expectedRevision: status.revision, expectedJournalPin: status.journalPin, clientRequestId: offerRequest, role, scopes, ttlSeconds: 300 })).json);
  const bundle = JSON.parse(made.invitation!.text) as { offerId: string; code: string };
  const claimed = await call(l.trust!, device, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name });
  assert.equal(claimed.status, 200);
  return { offerId: bundle.offerId, offerRequest, claimId: claimed.json.claimId as string };
}
const list = async (l: Lab) => OwnerPairingClaimsListSchema.parse((await l.api("GET", "/v1/owner/app-client-pairing/claims")).json);
/** The journal pin is read from this host's own claims list (synchronous port), exactly what the app shows. */
const pinOf = (l: Lab): string => (l.services.ownerPairingOffersHttp.claims!.list() as { journalPin: string | null }).journalPin ?? "0".repeat(64);
const decide = (l: Lab, claim: OwnerPairingClaim, revision: number, extra: Record<string, unknown> = {}) => {
  const body = { expectedHostId: l.services.store.hostId, expectedRevision: revision, expectedJournalPin: pinOf(l), clientRequestId: uuid(), decision: "approve",
    expectedClaimPin: claim.claimPin, expectedClientFingerprint: claim.clientFingerprint, ...extra };
  return { body, send: () => l.api("POST", `/v1/owner/app-client-pairing/claims/${claim.claimId}/decision`, body) };
};
const clientStatus = (l: Lab, device: TlsIdentity, claimId: string) => call(l.trust!, device, "POST", "/app-client/v1/pair/status", { claimId });

test("unconfigured channel: explicit unavailable list, every decision refused, no journal or TLS material created", async (t) => {
  const l = await lab(t, { appClients: false });
  const before = readdirSync(l.dataDir).sort();
  const claims = await list(l);
  assert.equal(claims.availability, "unavailable"); assert.equal(claims.reason, "app_client_channel_unconfigured"); assert.deepEqual(claims.items, []);
  assert.equal(claims.revision, 1);
  const claimId = `ccl_${uuid()}`;
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/claims/${claimId}`)).status, 503);
  const refused = await l.api("POST", `/v1/owner/app-client-pairing/claims/${claimId}/decision`, { expectedHostId: l.services.store.hostId, expectedRevision: 1,
    expectedJournalPin: "0".repeat(64), clientRequestId: uuid(), decision: "approve", expectedClaimPin: "a".repeat(64), expectedClientFingerprint: "b".repeat(64) });
  assert.equal(refused.status, 503); assert.equal(refused.json.error, "device_unavailable");
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/decisions/${uuid()}`)).status, 404);
  assert.deepEqual(readdirSync(l.dataDir).sort(), before, "no journal, registry, certificate or key");
  assert.equal(existsSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE)), false);
});

test("guards: owner loopback only, closed body (no owner/grant/scope/authority), claim id format, paired router 403 before any work", async (t) => {
  const l = await lab(t);
  const mac = l.identity("mac");
  const { claimId } = await invitedClaim(l, mac, HISTORICAL);
  const claim = (await list(l)).items[0]!;
  const { body } = decide(l, claim, 1);
  const path = `/v1/owner/app-client-pairing/claims/${claimId}/decision`;
  const expect = async (status: number, payload: unknown, init?: Parameters<Api>[3], at = path) => {
    const r = await l.api("POST", at, payload, init); assert.equal(r.status, status, String(JSON.stringify(payload)).slice(0, 100)); return r;
  };
  await expect(403, body, { headers: { host: "evil.example" } });
  await expect(403, body, { headers: { origin: "http://evil.example" } });
  await expect(415, undefined, { raw: JSON.stringify(body), headers: { "content-type": "text/plain" } });
  for (const extra of [{ ownerId: "own_x" }, { grants: [] }, { scopes: [...HISTORICAL, "outputs.read"] }, { role: "client-ios" }, { authority: "owner" },
    { deviceId: "dev_x" }, { capabilities: ["tools.run"] }]) await expect(400, { ...body, ...extra });
  await expect(400, { ...body, decision: "maybe" }); await expect(400, { ...body, expectedClaimPin: "nothex" });
  await expect(400, { ...body, clientRequestId: "not-a-uuid" });
  await expect(400, body, undefined, `/v1/owner/app-client-pairing/claims/not-a-claim/decision`);
  await expect(413, { ...body, padding: "x".repeat(5000) });
  await expect(403, body, { env: { authority: { principal: "paired-client" } } });
  assert.equal((await l.api("GET", "/v1/owner/app-client-pairing/claims?all=1")).status, 400);
  assert.equal((await list(l)).revision, 1, "nothing reserved");
  assert.equal((await list(l)).items[0]!.status, "pending");
  // A paired client (even one with every historical scope) never reaches the owner review routes.
  const iphone = l.identity("iphone");
  const other = await invitedClaim(l, iphone, HISTORICAL, "client-ios", "iPhone");
  l.services.appClientsAdmin.approveClaim(other.claimId);
  for (const [method, at, payload] of [["GET", "/v1/owner/app-client-pairing/claims"], ["GET", `/v1/owner/app-client-pairing/claims/${claimId}`],
    ["POST", path, body], ["GET", `/v1/owner/app-client-pairing/decisions/${body.clientRequestId}`]] as const)
    assert.equal((await call(l.trust!, iphone, method, at, payload)).status, 403, `${method} ${at}`);
  assert.equal((await list(l)).items.find(item => item.claimId === claimId)?.status, "pending", "the paired client changed nothing");
});

test("approve: exact offer role/scopes and certificate pin, no grant, outputs.manage never gains read; replay, conflicts and stale pins refused first", async (t) => {
  const l = await lab(t);
  const mac = l.identity("mac"), scopes = [...HISTORICAL, "outputs.manage"].sort();
  const { claimId, offerId, offerRequest } = await invitedClaim(l, mac, scopes);
  const claims = await list(l);
  assert.equal(claims.availability, "available"); assert.equal(claims.items.length, 1);
  const claim = claims.items[0]!;
  assert.equal(claim.claimId, claimId); assert.equal(claim.offerId, offerId); assert.equal(claim.offerClientRequestId, offerRequest);
  assert.equal(claim.kind, "pair"); assert.equal(claim.role, "client-mac"); assert.deepEqual(claim.scopes, scopes); assert.equal(claim.name, "Mac sintético");
  assert.equal(claim.clientFingerprint, mac.fingerprint); assert.equal(claim.status, "pending"); assert.equal(claim.binding, null); assert.equal(claim.targetDeviceId, null);
  assert.deepEqual(OwnerPairingClaimSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/claims/${claimId}`)).json), claim);
  const devicesBefore = l.devices();
  // Stale or foreign pins are refused before any reservation.
  for (const extra of [{ expectedClaimPin: "f".repeat(64) }, { expectedClientFingerprint: "e".repeat(64) }, { expectedHostId: "host_other" }, { expectedRevision: 2 }])
    assert.equal((await decide(l, claim, 1, extra).send()).status, 409, JSON.stringify(extra));
  const raised = ownerClaimPin({ ...claim, scopes: [...HISTORICAL, "outputs.manage", "outputs.read"].sort() } as unknown as OwnerClaimRecordSource);
  assert.equal((await decide(l, claim, 1, { expectedClaimPin: raised }).send()).status, 409, "a pin over more scopes cannot be approved");
  assert.equal((await list(l)).revision, 1); assert.equal(l.devices(), devicesBefore);
  const approval = decide(l, claim, 1);
  const done = await approval.send();
  assert.equal(done.status, 201);
  const record = OwnerPairingDecisionRecordSchema.parse(done.json);
  assert.equal(record.receipt.outcome, "approved"); assert.equal(record.receipt.operation, "approve"); assert.equal(record.receipt.grantsCreated, 0);
  assert.equal(record.receipt.previousRevision, 1); assert.equal(record.receipt.revision, 2);
  assert.deepEqual(record.receipt.binding?.scopes, scopes); assert.equal(record.receipt.binding?.fingerprint, mac.fingerprint);
  assert.equal(record.receipt.binding?.role, "client-mac"); assert.equal(record.receipt.binding?.generation, 1);
  assert.equal(record.claim?.status, "approved"); assert.equal(record.claim?.approvedDeviceId, record.receipt.binding?.deviceId);
  assert.equal(l.grants(), 0, "approval creates no grant for any bot"); assert.equal(l.devices(), devicesBefore + 1);
  // The other device sees exactly the offer's scopes; manage still cannot read output folders.
  const approved = await clientStatus(l, mac, claimId);
  assert.equal(approved.json.status, "approved"); assert.deepEqual(approved.json.scopes, scopes);
  assert.deepEqual(((await call(l.trust!, mac, "GET", "/health")).json.client as { scopes: string[] }).scopes, scopes);
  assert.equal((await call(l.trust!, mac, "GET", "/v1/output-files/status")).status, 403);
  // The owner's invitation record now reads claimed.
  assert.equal(OwnerPairingRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${offerRequest}`)).json).live.offerState, "claimed");
  // Exact replay → original receipt; same id other body → 409; a new decision on a decided claim → 409; nothing new created.
  const replay = await l.api("POST", `/v1/owner/app-client-pairing/claims/${claimId}/decision`, approval.body);
  assert.equal(replay.status, 200); assert.deepEqual(OwnerPairingDecisionRecordSchema.parse(replay.json).receipt, record.receipt);
  assert.equal((await l.api("POST", `/v1/owner/app-client-pairing/claims/${claimId}/decision`, { ...approval.body, decision: "reject" })).status, 409);
  assert.equal((await decide(l, claim, 2).send()).status, 409, "no longer pending");
  assert.equal((await list(l)).revision, 2); assert.equal(l.devices(), devicesBefore + 1); assert.deepEqual((await list(l)).items, []);
  const lost = OwnerPairingDecisionRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/decisions/${approval.body.clientRequestId}`)).json);
  assert.deepEqual(lost.receipt, record.receipt);
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/decisions/${uuid()}`)).status, 404);
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/decisions/${offerRequest}`)).status, 404, "an offer receipt is not a decision");
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${approval.body.clientRequestId}`)).status, 404, "a decision is not an offer receipt");
});

test("reject: the certificate never authenticates; restart keeps receipts; revoked binding shows revoked; crash after reservation reads unknown", async (t) => {
  const l = await lab(t);
  const iphone = l.identity("iphone");
  const rejected = await invitedClaim(l, iphone, HISTORICAL, "client-ios", "iPhone desconhecido");
  const pending = (await list(l)).items[0]!;
  const no = decide(l, pending, 1, { decision: "reject" });
  const result = OwnerPairingDecisionRecordSchema.parse((await no.send()).json);
  assert.equal(result.receipt.outcome, "rejected"); assert.equal(result.receipt.binding, null); assert.equal(result.claim?.status, "rejected");
  assert.equal((await clientStatus(l, iphone, rejected.claimId)).json.status, "rejected");
  assert.equal((await call(l.trust!, iphone, "GET", "/health")).status, 403);
  // Approved device, then revoked by the owner: the review shows the revoked binding; the receipt stays the original.
  const mac = l.identity("mac");
  const ok = await invitedClaim(l, mac, HISTORICAL);
  const yes = decide(l, (await list(l)).items[0]!, 2);
  const approved = OwnerPairingDecisionRecordSchema.parse((await yes.send()).json);
  const deviceId = approved.receipt.binding!.deviceId;
  // Lost ACK + host restart: only GET; the receipt and the device are the same, nothing re-issued.
  const devices = l.devices();
  await l.reopen();
  const afterRestart = OwnerPairingDecisionRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/decisions/${yes.body.clientRequestId}`)).json);
  assert.deepEqual(afterRestart.receipt, approved.receipt); assert.equal(afterRestart.claim?.status, "approved");
  const again = await l.api("POST", `/v1/owner/app-client-pairing/claims/${ok.claimId}/decision`, yes.body);
  assert.equal(again.status, 200); assert.deepEqual(OwnerPairingDecisionRecordSchema.parse(again.json).receipt, approved.receipt);
  assert.equal(l.devices(), devices, "no new identity or device after restart/replay");
  assert.equal((await clientStatus(l, mac, ok.claimId)).json.status, "approved");
  l.services.peersHttp!.revoke(deviceId);
  const revoked = OwnerPairingClaimSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/claims/${ok.claimId}`)).json);
  assert.equal(revoked.binding?.status, "revoked");
  assert.equal((await call(l.trust!, mac, "GET", "/health")).status, 403);
  // Crash between the reservation and its receipt: the provisional receipt reads unknown; the live claim tells the truth.
  await l.services.shutdown();
  const db = new DatabaseSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE));
  const provisional = { ...approved.receipt, outcome: "unknown", binding: null };
  db.prepare("UPDATE requests SET state = 'reserved', receipt = ? WHERE client_request_id = ?").run(JSON.stringify(provisional), yes.body.clientRequestId); db.close();
  await l.reopen();
  const unknown = OwnerPairingDecisionRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/decisions/${yes.body.clientRequestId}`)).json);
  assert.equal(unknown.receipt.outcome, "unknown"); assert.equal(unknown.claim?.status, "approved");
  const replayUnknown = await l.api("POST", `/v1/owner/app-client-pairing/claims/${ok.claimId}/decision`, yes.body);
  assert.equal(replayUnknown.status, 200); assert.equal(OwnerPairingDecisionRecordSchema.parse(replayUnknown.json).receipt.outcome, "unknown");
  assert.equal(l.devices(), devices);
});

test("rotation keeps the exact scopes and needs an active device; owner host switch and foreign journal refused untouched", async (t) => {
  const l = await lab(t);
  const mac = l.identity("mac"), scopes = [...HISTORICAL, "outputs.read"].sort();
  await invitedClaim(l, mac, scopes);
  const approved = OwnerPairingDecisionRecordSchema.parse((await decide(l, (await list(l)).items[0]!, 1).send()).json);
  const deviceId = approved.receipt.binding!.deviceId;
  // Key rotation (offer from the CLI path): approving keeps role and scopes; generation moves.
  const rotateOffer = l.services.appClientsAdmin.pairingBundle({ kind: "rotate", deviceId });
  const rotated = l.identity("mac-rotated");
  const claimed = await call(l.trust!, rotated, "POST", "/app-client/v1/pair/claim", { offerId: rotateOffer.offerId, code: rotateOffer.code, name: "Mac nova chave" });
  const rotation = (await list(l)).items[0]!;
  assert.equal(rotation.kind, "rotate"); assert.equal(rotation.targetDeviceId, deviceId); assert.deepEqual(rotation.scopes, scopes);
  assert.equal(rotation.offerClientRequestId, null, "offer did not come from the owner app flow"); assert.equal(rotation.binding?.status, "active");
  const rotateDone = OwnerPairingDecisionRecordSchema.parse((await decide(l, rotation, 2).send()).json);
  assert.equal(rotateDone.receipt.outcome, "approved"); assert.deepEqual(rotateDone.receipt.binding?.scopes, scopes); assert.equal(rotateDone.receipt.binding?.generation, 2);
  assert.equal(rotateDone.receipt.binding?.deviceId, deviceId); assert.equal(l.grants(), 0);
  assert.equal((await clientStatus(l, rotated, claimed.json.claimId as string)).json.status, "approved");
  // A rotation claim for a device revoked meanwhile is refused before any reservation.
  const second = l.services.appClientsAdmin.pairingBundle({ kind: "rotate", deviceId });
  const third = l.identity("mac-third");
  await call(l.trust!, third, "POST", "/app-client/v1/pair/claim", { offerId: second.offerId, code: second.code, name: "Mac terceira chave" });
  const stale = (await list(l)).items[0]!;
  l.services.peersHttp!.revoke(deviceId);
  assert.equal((await decide(l, stale, 3).send()).status, 409); assert.equal((await list(l)).revision, 3);
  // Another base: expected host mismatch and a copied journal are refused; the copy is never rewritten.
  const other = await lab(t);
  // The decision captured on this base (its host id) sent to another base is refused before anything else.
  assert.equal((await other.api("POST", `/v1/owner/app-client-pairing/claims/${stale.claimId}/decision`, decide(l, stale, 1).body)).status, 409);
  const target = join(other.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE);
  await l.services.shutdown();
  copyFileSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE), target); chmodSync(target, 0o600);
  for (const sidecar of ["-wal", "-shm"]) if (existsSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE + sidecar))) copyFileSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE + sidecar), target + sidecar);
  const pinned = sha(readFileSync(target));
  assert.equal((await other.api("GET", "/v1/owner/app-client-pairing/claims")).status, 409);
  assert.equal(sha(readFileSync(target)), pinned);
  await l.reopen();
});

test("own journal migration: a schema 1 (offers-only) journal is read as-is and migrated exactly once on the first decision", async (t) => {
  const l = await lab(t);
  await l.services.shutdown();
  // The exact schema "1" the offers parcel created, with one finished create receipt and offers revision 5.
  const path = join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE), { hostId, ownerId } = (() => { const s = new HostStore({ dataDir: l.dataDir }); try { return { hostId: s.hostId, ownerId: s.ownerId }; } finally { s.close(); } })();
  const v1 = new DatabaseSync(path);
  v1.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  v1.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE requests (client_request_id TEXT PRIMARY KEY, operation TEXT NOT NULL CHECK (operation IN ('create', 'cancel')),
  request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved', 'done')), previous_revision INTEGER NOT NULL CHECK (previous_revision >= 1),
  revision INTEGER NOT NULL CHECK (revision = previous_revision + 1), offer_id TEXT, receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 1), updated_at INTEGER NOT NULL) STRICT;`);
  for (const [k, v] of [["schema_version", "1"], ["namespace", "owner-pairing-offer-v1"], ["installation_id", hostId], ["owner_id", ownerId]] as const) v1.prepare("INSERT INTO meta VALUES (?, ?)").run(k, v);
  v1.prepare("INSERT INTO state VALUES (1, 5, 1)").run();
  const oldRequest = uuid(), oldOffer = `cof_${uuid()}`;
  const oldReceipt = { version: 1, hostId, clientRequestId: oldRequest, requestHash: "c".repeat(64), operation: "create", previousRevision: 4, revision: 5, outcome: "created",
    offer: { offerId: oldOffer, kind: "pair", role: "client-ios", scopes: HISTORICAL, expiresAt: 1_800_000_600_000, installationId: hostId, hostUrl: "https://127.0.0.1:9", hostFingerprint: "d".repeat(64) },
    invitationSha256: "e".repeat(64), grantsCreated: 0, createdAt: 1_800_000_000_000 };
  // Recent (inside the 7-day receipt retention), so the first write keeps it.
  v1.prepare("INSERT INTO requests VALUES (?, 'create', ?, 'done', 4, 5, ?, ?, ?, ?)").run(oldRequest, oldReceipt.requestHash, oldOffer, JSON.stringify(oldReceipt), Date.now(), Date.now());
  v1.close(); chmodSync(path, 0o600);
  await l.reopen();
  // Receipt reads take the journal as-is (no write); the old receipt is intact.
  const meta = (): Record<string, string> => { const db = new DatabaseSync(path, { readOnly: true });
    try { return Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(r => [r.key, r.value])); } finally { db.close(); } };
  assert.deepEqual(OwnerPairingRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${oldRequest}`)).json).receipt, oldReceipt);
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/decisions/${uuid()}`)).status, 404);
  assert.equal(meta().schema_version, "1", "receipt reads never migrate"); assert.equal(meta().instance_id, undefined);
  // The status issues the journal pin: it migrates schema 1 exactly once (instance id added), keeping offers revision 5.
  const status = (await l.api("GET", "/v1/owner/app-client-pairing/status")).json as { revision: number; journalPin: string };
  assert.equal(status.revision, 5); assert.match(status.journalPin, /^[0-9a-f]{64}$/);
  const once = meta();
  assert.equal(once.schema_version, "2"); assert.match(once.instance_id!, /^[0-9a-f-]{36}$/);
  assert.equal((await list(l)).revision, 1); assert.equal((await list(l)).journalPin, status.journalPin, "one journal, one pin");
  assert.equal(((await l.api("GET", "/v1/owner/app-client-pairing/status")).json as { journalPin: string }).journalPin, status.journalPin);
  assert.deepEqual(meta(), once, "migrated exactly once: same instance, no second migration");
  const mac = l.identity("mac");
  await invitedClaim(l, mac, HISTORICAL);
  const migrated = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "2");
    assert.match(String((migrated.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as { value: string }).value), /^[0-9a-f-]{36}$/);
    assert.deepEqual((migrated.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name),
      ["claim_state", "meta", "requests", "state"]);
    assert.ok(!(migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'requests'").get() as { sql: string }).sql.includes('"'), "exact CREATE text, not a rename artifact");
  } finally { migrated.close(); }
  assert.deepEqual(OwnerPairingRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${oldRequest}`)).json).receipt, oldReceipt, "old receipt survives");
  assert.equal(((await l.api("GET", "/v1/owner/app-client-pairing/status")).json as { revision: number }).revision, 6, "offers revision continued");
  const done = OwnerPairingDecisionRecordSchema.parse((await decide(l, (await list(l)).items[0]!, 1).send()).json);
  assert.equal(done.receipt.outcome, "approved"); assert.equal((await list(l)).revision, 2);
  // Unknown schema version is refused untouched.
  await l.services.shutdown();
  const bump = new DatabaseSync(path); bump.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run(); bump.close();
  const frozen = sha(readFileSync(path));
  await l.reopen();
  assert.equal((await l.api("GET", "/v1/owner/app-client-pairing/claims")).status, 409);
  assert.equal(sha(readFileSync(path)), frozen);
});

test("registry outcomes decide the receipt: thrown effects read back as not_applied, approving as unknown, failed as failed (unit, synthetic ports)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-owner-claims-unit-"))); chmodSync(root, 0o700);
  try {
    const hostId = "host_unit", now = { value: 1_800_000_000_000 };
    const journal = new OwnerPairingJournal({ dataDir: root, identity: () => ({ hostId, ownerId: "owner_unit" }), now: () => now.value, writer: op => op() });
    const records = new Map<string, OwnerClaimRecordSource>();
    let effect: "throw" | "approving" | "failed" = "throw", approvals = 0;
    const admin: OwnerPairingClaimsAdminPort = {
      pendingClaimRecords: () => [...records.values()].filter(r => r.status === "pending"),
      claimRecord: id => records.get(id) ?? null,
      approveClaim: id => { approvals++; const r = records.get(id)!;
        if (effect === "approving") { r.status = "approving"; throw new Error("enrollment interrupted"); }
        if (effect === "failed") { r.status = "failed"; throw new Error("diverged"); }
        throw new Error("refused before change"); },
      rejectClaim: () => { throw new Error("refused"); },
    };
    const service = new OwnerPairingClaims({ journal, identity: () => ({ hostId, ownerId: "owner_unit" }), admin: () => admin, binding: () => null, closing: () => false });
    const add = (): OwnerClaimRecordSource => {
      const r: OwnerClaimRecordSource = { claimId: `ccl_${randomUUID()}`, offerId: `cof_${randomUUID()}`, kind: "pair", role: "client-ios", scopes: HISTORICAL, targetDeviceId: null,
        approvedDeviceId: null, clientFingerprint: "a".repeat(64), name: "Unit", status: "pending", expiresAt: now.value + 60_000, createdAt: now.value, decidedAt: null };
      records.set(r.claimId, r); return r;
    };
    const run = (r: OwnerClaimRecordSource, revision: number, decision = "approve") => service.decide(r.claimId, { expectedHostId: hostId, expectedRevision: revision,
      expectedJournalPin: journal.pin(), clientRequestId: randomUUID(), decision, expectedClaimPin: ownerClaimPin(r), expectedClientFingerprint: r.clientFingerprint });
    assert.equal(run(add(), 1).result.receipt.outcome, "not_applied");
    assert.equal(run(add(), 2, "reject").result.receipt.outcome, "not_applied");
    effect = "approving"; assert.equal(run(add(), 3).result.receipt.outcome, "unknown");
    effect = "failed"; assert.equal(run(add(), 4).result.receipt.outcome, "failed");
    assert.equal(approvals, 3, "each decision reaches the registry exactly once");
    assert.equal(service.list().revision, 5);
    journal.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Operations: the migrated journal stays an excluded checkpoint entry; decisions and pins never enter the artifact", async (t) => {
  const l = await lab(t);
  const mac = l.identity("mac");
  await invitedClaim(l, mac, HISTORICAL);
  const claim = (await list(l)).items[0]!;
  assert.equal((await decide(l, claim, 1).send()).status, 201);
  await l.services.shutdown();
  const report = doctor(l.dataDir);
  assert.ok(report.excludedPresent.includes(OWNER_PAIRING_OFFERS_DATABASE_FILE)); assert.equal(report.unknownEntries, 0); assert.equal(report.hub.schemaVersion, 16);
  const out = realpathSync(mkdtempSync(join(tmpdir(), "dx-owner-claims-ckp-"))); chmodSync(out, 0o700);
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const store = new HostStore({ dataDir: l.dataDir });
  try {
    const checkpoint = store.checkpointForTransfer("ckp_owner_claims_fixture_2026");
    const key = { keyId: "synthetic-owner-claims", use: <T>(fn: (k: ReturnType<typeof createSecretKey>) => T) => fn(createSecretKey(Buffer.alloc(32, 5))) };
    const artifact = captureCheckpointArtifact({ source: store, checkpoint, key, output: join(out, "claims.dxg8") });
    const opened = openCheckpointArtifact(artifact.path, key);
    assert.ok(opened.manifest.excluded.present.includes(OWNER_PAIRING_OFFERS_DATABASE_FILE));
    assert.ok(![...opened.members.keys()].some(name => name.includes("owner-pairing")));
    for (const [, bytes] of opened.members) assert.ok(!bytes.includes(claim.claimPin), "no claim pin from the owner journal in any member");
    assert.equal(opened.manifest.counts.appClients?.claims.approved, 1);
  } finally { store.close(); }
});
