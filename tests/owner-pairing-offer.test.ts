import assert from "node:assert/strict";
import { createHash, createSecretKey, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import { OwnerPairingInvitationReadSchema, OwnerPairingOfferResultSchema, OwnerPairingRecordSchema, OwnerPairingStatusSchema,
  OWNER_PAIRING_HISTORICAL_SCOPES } from "@dexter/contracts";
import { captureCheckpointArtifact, doctor, openCheckpointArtifact } from "@dexter/operations";
import { HostServices } from "../packages/cli/src/host-services.js";
import { OwnerPairingOffers, OWNER_PAIRING_OFFERS_DATABASE_FILE, type OwnerPairingAdminPort, type OwnerPairingBundleSource } from "../packages/cli/src/owner-pairing-offer.js";
import { call, clientIdentity, hostIdentity, type Trust } from "./app-client-lab.js";
import type { TlsIdentity } from "@dexter/devices";

// Owner pairing offer (owner-loopback): real HostServices + real mutual-TLS app-client listener (synthetic lab
// certificates, loopback, random port) + real createHostApp/Hono. No account, Keychain, TCC, SSH, provider or product port.
// Pairing codes stay in test memory; nothing here prints them.
const HISTORICAL = [...OWNER_PAIRING_HISTORICAL_SCOPES];
const INVITATION_KEYS = ["code", "deviceId", "expiresAt", "hostCertificateDER", "hostFingerprint", "hostUrl", "installationId", "kind", "offerId", "protocol", "role", "scopes"];
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const uuid = (): string => randomUUID();
type Api = (method: string, path: string, body?: unknown, init?: { headers?: Record<string, string>; raw?: string; env?: object }) => Promise<{ status: number; json: Record<string, unknown> }>;
interface Lab { root: string; dataDir: string; services: HostServices; api: Api; trust: Trust | null; host: TlsIdentity; identity(label: string): TlsIdentity;
  reopen(): Promise<void>; offersCount(): number }

function api(get: () => ReturnType<typeof createHostApp>): Api {
  return async (method, path, body, init = {}) => {
    const headers = { ...(body !== undefined || init.raw !== undefined ? { "content-type": "application/json" } : {}), ...init.headers };
    const response = await get().request("http://127.0.0.1" + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : init.raw !== undefined ? { body: init.raw } : {}) },
      init.env as never);
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
  };
}
async function lab(t: TestContext, options: { appClients?: boolean; start?: boolean; offerTtlMs?: number } = {}): Promise<Lab> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-owner-pairing-"))); chmodSync(root, 0o700);
  const host = hostIdentity(join(root, "id-host")), dataDir = join(root, "host");
  const open = () => new HostServices({ dataDir, ...(options.appClients === false ? {} : { appClients: { identity: host, ...(options.offerTtlMs ? { offerTtlMs: options.offerTtlMs } : {}) } }) });
  let services = open(), app = createHostApp(services.store, { ownerPairingOffers: services.ownerPairingOffersHttp, outputFiles: services.outputFilesHttp });
  let trust: Trust | null = null;
  const start = async () => { if (options.appClients !== false && options.start !== false) trust = { url: await services.startAppClients(), certPem: host.certPem, fingerprint: host.fingerprint }; };
  await start();
  t.after(async () => { await services.shutdown(); rmSync(root, { recursive: true, force: true }); });
  let n = 0;
  return { root, dataDir, get services() { return services; }, api: api(() => app), get trust() { return trust; }, host,
    identity: label => clientIdentity(join(root, `id-${label}-${++n}`)),
    reopen: async () => { await services.shutdown(); services = open(); app = createHostApp(services.store, { ownerPairingOffers: services.ownerPairingOffersHttp, outputFiles: services.outputFilesHttp }); await start(); },
    offersCount: () => { const db = new DatabaseSync(join(dataDir, "app-clients.sqlite"), { readOnly: true }); try { return Number((db.prepare("SELECT COUNT(*) AS n FROM offers").get() as { n: number }).n); } finally { db.close(); } },
  } as Lab;
}
const status = async (l: Lab) => OwnerPairingStatusSchema.parse((await l.api("GET", "/v1/owner/app-client-pairing/status")).json);
const create = (l: Lab, body: Record<string, unknown>) => l.api("POST", "/v1/owner/app-client-pairing/offers", body);
// The journal pin comes from the status; a placeholder only for requests refused before the pin check (no channel/foreign).
const NO_PIN = "0".repeat(64);
const offerBody = (status: { hostId: string; journalPin: string | null }, revision: number, extra: Record<string, unknown> = {}) =>
  ({ expectedHostId: status.hostId, expectedRevision: revision, expectedJournalPin: status.journalPin ?? NO_PIN, clientRequestId: uuid(), role: "client-mac", scopes: HISTORICAL, ttlSeconds: 300, ...extra });
function files(dir: string): string[] { return readdirSync(dir, { recursive: true }).map(String).sort(); }
function fileBytes(path: string): Buffer { return Buffer.concat([path, `${path}-wal`].filter(existsSync).map(p => readFileSync(p))); }

test("unconfigured or stopped channel: explicit unavailable status, every mutation refused with no journal, no TLS/key material created", async (t) => {
  const bare = await lab(t, { appClients: false });
  const before = files(bare.dataDir);
  const s = await status(bare);
  assert.equal(s.availability, "unavailable"); assert.equal(s.reason, "app_client_channel_unconfigured");
  assert.deepEqual(s.channel, { status: "unconfigured", installationId: null, hostUrl: null, hostFingerprint: null, certificateNotAfter: null });
  assert.equal(s.ttl, null); assert.equal(s.revision, 1);
  const refused = await create(bare, offerBody(s, 1));
  assert.equal(refused.status, 503); assert.equal(refused.json.error, "device_unavailable");
  assert.equal(existsSync(join(bare.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE)), false, "no journal before a real decision");
  assert.deepEqual(files(bare.dataDir), before, "nothing created: no certificate, key, journal or registry");
  assert.ok(!files(bare.dataDir).some(name => /cert|key|identity|app-clients/.test(name)));

  const stopped = await lab(t, { start: false });
  const st = await status(stopped);
  assert.equal(st.reason, "app_client_listener_not_listening"); assert.equal(st.channel.status, "not_listening"); assert.equal(st.channel.hostUrl, null);
  assert.equal(st.channel.installationId, stopped.services.store.hostId); assert.equal(st.channel.hostFingerprint, stopped.host.fingerprint);
  assert.equal((await create(stopped, offerBody(st, 1))).status, 503);
  assert.equal(existsSync(join(stopped.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE)), false);
  assert.equal(stopped.offersCount(), 0, "no registry offer");
});

test("owner-loopback guards: Host/Origin/content type, closed body (no owner/grant/capability/kind), closed scopes, TTL limits, UUID, paired authority refused", async (t) => {
  const l = await lab(t, { offerTtlMs: 600_000 });
  const s = await status(l);
  assert.equal(s.availability, "available"); assert.equal(s.reason, null);
  assert.deepEqual(s.ttl, { minSeconds: 60, maxSeconds: 600, defaultSeconds: 600 });
  assert.deepEqual(s.scopes, { historical: HISTORICAL, optIn: ["connections.manage", "connections.read", "mcp.manage", "mcp.read", "outputs.manage", "outputs.read"] });
  const base = offerBody(s, 1);
  const expect = async (status: number, body: unknown, init?: Parameters<Api>[3]) => {
    const r = await l.api("POST", "/v1/owner/app-client-pairing/offers", body, init); assert.equal(r.status, status, String(JSON.stringify(body)).slice(0, 120)); return r;
  };
  await expect(403, base, { headers: { host: "evil.example" } });
  await expect(403, base, { headers: { origin: "http://evil.example" } });
  await expect(415, undefined, { raw: JSON.stringify(base), headers: { "content-type": "text/plain" } });
  for (const extra of [{ ownerId: "own_x" }, { grants: [] }, { capabilities: ["tools.run"] }, { kind: "rotate" }, { deviceId: "dev_x" }, { scope: "chat.read" }])
    await expect(400, { ...base, ...extra });
  const { scopes: _omit, ...withoutScopes } = base;
  await expect(400, withoutScopes);
  await expect(400, { ...base, scopes: ["tools.run"] });
  await expect(400, { ...base, scopes: ["chat.write", "chat.read"] }, undefined);
  await expect(400, { ...base, scopes: ["chat.read", "chat.read"] });
  await expect(400, { ...base, role: "agent-mac" });
  await expect(400, { ...base, ttlSeconds: 59 }); await expect(400, { ...base, ttlSeconds: 3601 }); await expect(400, { ...base, ttlSeconds: 90.5 });
  const beyond = await expect(400, { ...base, ttlSeconds: 900 });
  assert.equal(beyond.json.error, "invalid_input", "longer than the host's configured offer lifetime");
  await expect(400, { ...base, clientRequestId: base.clientRequestId.toUpperCase() });
  await expect(400, { ...base, clientRequestId: "not-a-uuid" });
  await expect(413, { ...base, padding: "x".repeat(5000) });
  await expect(403, base, { env: { authority: { principal: "paired-client" } } });
  assert.equal((await l.api("GET", "/v1/owner/app-client-pairing/status?x=1")).status, 400);
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${uuid()}/invitation`)).status, 400, "pin is required");
  assert.equal((await status(l)).revision, 1, "no refused request reserved a revision");
  // The available status materialized only the journal identity (its pin): no request, no revision moved, no offer.
  const journal = new DatabaseSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE), { readOnly: true });
  try {
    assert.equal(Number((journal.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n), 0);
    assert.equal(Number((journal.prepare("SELECT revision FROM state WHERE id = 1").get() as { revision: number }).revision), 1);
    assert.match(String((journal.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as { value: string }).value), /^[0-9a-f-]{36}$/);
  } finally { journal.close(); }
  assert.equal(l.offersCount(), 0);
  // The paired-client router refuses every pairing-offer route before any work (no scope can reach them).
  const iphone = l.identity("iphone");
  const offer = l.services.appClientsAdmin.pairingBundle({ kind: "pair", role: "client-ios", scopes: [...HISTORICAL] as never });
  const claimed = await call(l.trust!, iphone, "POST", "/app-client/v1/pair/claim", { offerId: offer.offerId, code: offer.code, name: "iPhone sintético" });
  l.services.appClientsAdmin.approveClaim(claimed.json.claimId as string);
  for (const [method, path, body] of [["GET", "/v1/owner/app-client-pairing/status"], ["POST", "/v1/owner/app-client-pairing/offers", offerBody(s, 1)],
    ["GET", `/v1/owner/app-client-pairing/receipts/${uuid()}`], ["GET", `/v1/owner/app-client-pairing/receipts/${uuid()}/invitation?requestHash=${"0".repeat(64)}`],
    ["POST", `/v1/owner/app-client-pairing/offers/cof_${uuid()}/cancel`, { expectedHostId: s.hostId, expectedRevision: 1, clientRequestId: uuid() }]] as const)
    assert.equal((await call(l.trust!, iphone, method, path, body)).status, 403, `${method} ${path}`);
  assert.equal(l.offersCount(), 1, "only the lab's own direct offer");
});

test("create: invitation is exactly the CLI bundle, outputs off unless opted in, manage without read stays without read end to end; code never persisted", async (t) => {
  const l = await lab(t);
  const s = await status(l);
  assert.equal(s.channel.status, "listening"); assert.equal(s.channel.hostUrl, l.trust!.url); assert.equal(s.channel.hostFingerprint, l.host.fingerprint);
  assert.equal(s.channel.installationId, s.hostId); assert.ok(s.channel.certificateNotAfter! > Date.now());
  const scopes = [...HISTORICAL, "outputs.manage"].sort();
  const body = offerBody(s, 1, { role: "client-mac", scopes, ttlSeconds: 300 });
  const before = Date.now();
  const r = await create(l, body);
  assert.equal(r.status, 201);
  const result = OwnerPairingOfferResultSchema.parse(r.json), receipt = result.record.receipt, invitation = result.invitation!;
  assert.equal(receipt.outcome, "created"); assert.equal(receipt.operation, "create"); assert.equal(receipt.previousRevision, 1); assert.equal(receipt.revision, 2);
  assert.equal(receipt.grantsCreated, 0); assert.equal(receipt.clientRequestId, body.clientRequestId);
  assert.deepEqual(result.record.live, { offerState: "open", invitation: "retained" });
  assert.equal(invitation.deliveriesRemaining, 2); assert.equal(invitation.sha256, sha(invitation.text)); assert.equal(receipt.invitationSha256, invitation.sha256);
  assert.ok(invitation.text.endsWith("\n"));
  const bundle = JSON.parse(invitation.text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(bundle).sort(), INVITATION_KEYS, "exactly the importer's 12 keys");
  assert.equal(invitation.text, JSON.stringify(bundle) + "\n", "same serialization as `dexter app-client offer`");
  assert.equal(bundle.protocol, "dexter-app-client-v1"); assert.equal(bundle.kind, "pair"); assert.equal(bundle.deviceId, null); assert.equal(bundle.role, "client-mac");
  assert.deepEqual(bundle.scopes, scopes); assert.ok(!(bundle.scopes as string[]).includes("outputs.read"), "manage never includes read");
  assert.equal(bundle.installationId, s.hostId); assert.equal(bundle.hostUrl, l.trust!.url); assert.equal(bundle.hostFingerprint, l.host.fingerprint);
  assert.equal(bundle.offerId, receipt.offer!.offerId); assert.match(String(bundle.code), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Number(bundle.expiresAt) >= before + 300_000 && Number(bundle.expiresAt) <= Date.now() + 300_000);
  assert.equal(receipt.offer!.expiresAt, bundle.expiresAt);
  const code = String(bundle.code);
  // Secret custody: never in the receipt, the journal, the registry, events or the status.
  assert.ok(!JSON.stringify(result.record).includes(code));
  assert.ok(!fileBytes(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE)).includes(code), "journal");
  assert.ok(!fileBytes(join(l.dataDir, "app-clients.sqlite")).includes(code), "registry keeps the hash only");
  assert.ok(!JSON.stringify(l.services.store.listEvents(0, 500)).includes(code), "events");
  assert.ok(!JSON.stringify(await status(l)).includes(code));
  assert.equal(readFileSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE)).length > 0, true);
  assert.equal((await status(l)).revision, 2);
  // The other device uses the invitation as-is over the real mutual-TLS channel; the owner approves; scopes stay exact.
  const mac = l.identity("mac");
  const claimed = await call(l.trust!, mac, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code, name: "Mac sintético" });
  assert.equal(claimed.status, 200);
  l.services.appClientsAdmin.approveClaim(claimed.json.claimId as string);
  const health = await call(l.trust!, mac, "GET", "/health");
  assert.deepEqual((health.json.client as { scopes: string[] }).scopes, scopes);
  assert.equal((await call(l.trust!, mac, "GET", "/v1/output-files/status")).status, 403, "outputs.manage alone cannot read");
  assert.equal(l.services.store.summary().counts.grants, 0, "pairing grants nothing to any bot");
  const record = OwnerPairingRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${body.clientRequestId}`)).json);
  assert.deepEqual(record.receipt, receipt); assert.deepEqual(record.live, { offerState: "claimed", invitation: "not_retained" });
  const read = OwnerPairingInvitationReadSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${body.clientRequestId}/invitation?requestHash=${receipt.requestHash}`)).json);
  assert.deepEqual(read.availability === "unavailable" ? read.reason : null, "claimed", "a used invitation is never shown again");
  // A second offer with the defaults: outputs are off unless the owner turned them on.
  const plain = OwnerPairingOfferResultSchema.parse((await create(l, offerBody(s, 2, { role: "client-ios" }))).json);
  assert.deepEqual(JSON.parse(plain.invitation!.text).scopes, HISTORICAL);
});

test("exact replay returns the original receipt; same id other body conflicts; revision CAS; lost ACK read by GET; finite pinned deliveries", async (t) => {
  const l = await lab(t);
  const s = await status(l), body = offerBody(s, 1);
  const first = OwnerPairingOfferResultSchema.parse((await create(l, body)).json);
  const replay = await create(l, body);
  assert.equal(replay.status, 200);
  const again = OwnerPairingOfferResultSchema.parse(replay.json);
  assert.deepEqual(again.record.receipt, first.record.receipt, "original receipt");
  assert.equal(again.invitation!.text, first.invitation!.text, "the same code, never a new one"); assert.equal(again.invitation!.deliveriesRemaining, 1);
  assert.equal(l.offersCount(), 1, "replay created nothing");
  const pinPath = (hash: string) => `/v1/owner/app-client-pairing/receipts/${body.clientRequestId}/invitation?requestHash=${hash}`;
  assert.equal((await l.api("GET", pinPath("f".repeat(64)))).status, 409, "pinned to the exact request");
  const lost = OwnerPairingInvitationReadSchema.parse((await l.api("GET", pinPath(first.record.receipt.requestHash))).json);
  assert.equal(lost.availability, "available");
  if (lost.availability === "available") { assert.equal(lost.invitation.text, first.invitation!.text); assert.equal(lost.invitation.deliveriesRemaining, 0); }
  const spent = OwnerPairingInvitationReadSchema.parse((await l.api("GET", pinPath(first.record.receipt.requestHash))).json);
  assert.deepEqual(spent.availability === "unavailable" ? spent.reason : null, "delivery_limit");
  const late = OwnerPairingOfferResultSchema.parse((await create(l, body)).json);
  assert.equal(late.invitation, null); assert.deepEqual(late.record.receipt, first.record.receipt); assert.equal(late.record.live.invitation, "not_retained");
  const conflict = await create(l, { ...body, scopes: [...HISTORICAL, "outputs.read"].sort() });
  assert.equal(conflict.status, 409, "same id, other body");
  assert.equal((await create(l, { ...body, clientRequestId: uuid() })).status, 409, "stale revision");
  assert.equal(l.offersCount(), 1); assert.equal((await status(l)).revision, 2);
  assert.equal((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${uuid()}`)).status, 404, "absent receipt is unconfirmed, never 'did not happen'");
  assert.equal((await create(l, { ...body, expectedHostId: "host_other", clientRequestId: uuid(), expectedRevision: 2 })).status, 409, "host switch");
  assert.equal((await status(l)).revision, 2);
});

test("restart: receipt survives, the code is never re-issued; cancel by the exact flow; foreign journal refused untouched", async (t) => {
  const l = await lab(t);
  const s = await status(l), body = offerBody(s, 1, { role: "client-ios" });
  const first = OwnerPairingOfferResultSchema.parse((await create(l, body)).json);
  const offerId = first.record.receipt.offer!.offerId, code = JSON.parse(first.invitation!.text).code as string;
  await l.reopen();
  const record = OwnerPairingRecordSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${body.clientRequestId}`)).json);
  assert.deepEqual(record.receipt, first.record.receipt); assert.deepEqual(record.live, { offerState: "open", invitation: "not_retained" });
  const read = OwnerPairingInvitationReadSchema.parse((await l.api("GET", `/v1/owner/app-client-pairing/receipts/${body.clientRequestId}/invitation?requestHash=${first.record.receipt.requestHash}`)).json);
  assert.deepEqual(read.availability === "unavailable" ? read.reason : null, "not_retained");
  const replay = OwnerPairingOfferResultSchema.parse((await create(l, body)).json);
  assert.equal(replay.invitation, null); assert.deepEqual(replay.record.receipt, first.record.receipt);
  assert.equal(l.offersCount(), 1, "nothing recreated after restart");
  // The owner revokes the (possibly shared) invitation explicitly.
  // Captured before the restart: the same journal and authority keep the same pin.
  const cancelBody = { expectedHostId: s.hostId, expectedRevision: 2, expectedJournalPin: s.journalPin!, clientRequestId: uuid() };
  const cancelled = await l.api("POST", `/v1/owner/app-client-pairing/offers/${offerId}/cancel`, cancelBody);
  assert.equal(cancelled.status, 201);
  const cancelRecord = OwnerPairingRecordSchema.parse(cancelled.json);
  assert.equal(cancelRecord.receipt.outcome, "cancelled"); assert.equal(cancelRecord.receipt.operation, "cancel"); assert.equal(cancelRecord.receipt.revision, 3);
  assert.equal(cancelRecord.live.offerState, "cancelled");
  const cancelReplay = await l.api("POST", `/v1/owner/app-client-pairing/offers/${offerId}/cancel`, cancelBody);
  assert.equal(cancelReplay.status, 200); assert.deepEqual(OwnerPairingRecordSchema.parse(cancelReplay.json).receipt, cancelRecord.receipt);
  const iphone = l.identity("iphone");
  assert.equal((await call(l.trust!, iphone, "POST", "/app-client/v1/pair/claim", { offerId, code, name: "iPhone" })).status, 403, "cancelled code refused");
  assert.equal((await l.api("POST", `/v1/owner/app-client-pairing/offers/${offerId}/cancel`, { ...cancelBody, clientRequestId: uuid(), expectedRevision: 3 })).status, 409, "no longer open");
  const cli = l.services.appClientsAdmin.pairingBundle({ kind: "pair", role: "client-ios", scopes: [] });
  assert.equal((await l.api("POST", `/v1/owner/app-client-pairing/offers/${cli.offerId}/cancel`, { ...cancelBody, clientRequestId: uuid(), expectedRevision: 3 })).status, 404,
    "only offers created through this flow");
  assert.equal((await status(l)).revision, 3);
  // A journal copied from another installation is refused, never rewritten.
  const other = await lab(t);
  const target = join(other.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE);
  copyFileSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE), target); chmodSync(target, 0o600);
  for (const sidecar of ["-wal", "-shm"]) if (existsSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE + sidecar))) copyFileSync(join(l.dataDir, OWNER_PAIRING_OFFERS_DATABASE_FILE + sidecar), target + sidecar);
  const pinned = sha(readFileSync(target));
  assert.equal((await other.api("GET", "/v1/owner/app-client-pairing/status")).status, 409);
  assert.equal((await create(other, offerBody({ hostId: other.services.store.hostId, journalPin: null }, 1))).status, 409);
  assert.equal(sha(readFileSync(target)), pinned); assert.equal(other.offersCount(), 0);
});

test("unconfirmed effects read as unknown, never as a new code; expiry and claim end retention (unit, synthetic ports)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-owner-pairing-unit-"))); chmodSync(root, 0o700);
  try {
    let now = 1_800_000_000_000, mode: "ok" | "throw" | "wrong-host" = "ok";
    const offers = new Map<string, { status: "open" | "claimed" | "cancelled" | "exhausted"; expiresAt: number }>();
    const cancelled: string[] = [];
    const admin: OwnerPairingAdminPort = {
      pairingBundle: (input, ttlMs): OwnerPairingBundleSource => {
        if (mode === "throw") throw new Error("lost effect");
        const offerId = `cof_${randomUUID()}`, expiresAt = now + ttlMs; offers.set(offerId, { status: "open", expiresAt });
        return { protocol: "dexter-app-client-v1", installationId: "host_unit", hostUrl: mode === "wrong-host" ? "https://127.0.0.9:1" : "https://127.0.0.1:9443",
          hostCertificateDER: "AAAA", hostFingerprint: "a".repeat(64), offerId, kind: "pair", role: input.role, scopes: [...input.scopes], deviceId: null, expiresAt,
          code: "C".repeat(43) };
      },
      offerState: id => { const o = offers.get(id); return o ? { status: o.status === "open" && o.expiresAt <= now ? "expired" : o.status, expiresAt: o.expiresAt } : null; },
      cancelOffer: id => { cancelled.push(id); const o = offers.get(id); if (o?.status === "open") o.status = "cancelled"; },
    };
    const make = () => new OwnerPairingOffers({ dataDir: root, identity: () => ({ hostId: "host_unit", ownerId: "owner_unit" }), now: () => now, writer: op => op(),
      channel: () => ({ listening: true, installationId: "host_unit", hostUrl: "https://127.0.0.1:9443", hostFingerprint: "a".repeat(64),
        certificateNotBefore: now - 1, certificateNotAfter: now + 86_400_000, offerTtlMs: 600_000 }), admin: () => admin, closing: () => false });
    let service = make();
    const body = (revision: number) => ({ expectedHostId: "host_unit", expectedRevision: revision, expectedJournalPin: service.status().journalPin!, clientRequestId: randomUUID(),
      role: "client-ios", scopes: HISTORICAL, ttlSeconds: 60 });
    mode = "throw";
    const lost = body(1);
    assert.throws(() => service.create(lost), (e: { code?: string }) => e.code === "outcome_unknown");
    assert.equal(service.status().revision, 2, "the reservation consumed the revision");
    assert.equal(service.record(lost.clientRequestId)!.receipt.outcome, "unknown");
    const replayUnknown = service.create(lost);
    assert.equal(replayUnknown.created, false); assert.equal(replayUnknown.result.invitation, null); assert.equal(replayUnknown.result.record.receipt.outcome, "unknown");
    const unknownRead = service.invitation(lost.clientRequestId, replayUnknown.result.record.receipt.requestHash);
    assert.deepEqual(unknownRead.availability === "unavailable" ? unknownRead.reason : null, "outcome_unknown");
    mode = "wrong-host";
    assert.throws(() => service.create(body(2)), (e: { code?: string }) => e.code === "outcome_unknown");
    assert.equal(cancelled.length, 1, "an undeliverable offer is cancelled, never shown");
    mode = "ok";
    const good = body(3), made = service.create(good);
    assert.equal(made.created, true);
    now += 61_000;
    const expired = service.invitation(good.clientRequestId, made.result.record.receipt.requestHash);
    assert.deepEqual(expired.availability === "unavailable" ? expired.reason : null, "expired");
    assert.equal(service.record(good.clientRequestId)!.live.offerState, "expired");
    // Crash between the reservation and its receipt: after reopening it reads as unknown, and is never re-issued.
    const crash = body(4), crashed = service.create(crash);
    assert.equal(crashed.created, true);
    service.close();
    const db = new DatabaseSync(join(root, OWNER_PAIRING_OFFERS_DATABASE_FILE));
    db.prepare("UPDATE requests SET state = 'reserved', receipt = NULL WHERE client_request_id = ?").run(crash.clientRequestId); db.close();
    service = make();
    const after = service.create(crash);
    assert.equal(after.created, false); assert.equal(after.result.record.receipt.outcome, "unknown"); assert.equal(after.result.invitation, null);
    assert.equal(offers.size, 3, "no new offer for any replay");
    service.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Operations: doctor and the authority checkpoint classify the journal as excluded; Hub schema and counts unchanged", async (t) => {
  const l = await lab(t);
  const s = await status(l);
  const made = OwnerPairingOfferResultSchema.parse((await create(l, offerBody(s, 1))).json);
  const code = JSON.parse(made.invitation!.text).code as string;
  await l.services.shutdown();
  const report = doctor(l.dataDir);
  assert.ok(report.excludedPresent.includes(OWNER_PAIRING_OFFERS_DATABASE_FILE)); assert.equal(report.unknownEntries, 0);
  assert.equal(report.hub.schemaVersion, 16);
  const out = realpathSync(mkdtempSync(join(tmpdir(), "dx-owner-pairing-ckp-"))); chmodSync(out, 0o700);
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const store = new HostStore({ dataDir: l.dataDir });
  try {
    const checkpoint = store.checkpointForTransfer("ckp_owner_pairing_fixture_2026");
    const key = { keyId: "synthetic-owner-pairing", use: <T>(fn: (k: ReturnType<typeof createSecretKey>) => T) => fn(createSecretKey(Buffer.alloc(32, 9))) };
    const artifact = captureCheckpointArtifact({ source: store, checkpoint, key, output: join(out, "pairing.dxg8") });
    const opened = openCheckpointArtifact(artifact.path, key);
    assert.ok(opened.manifest.excluded.present.includes(OWNER_PAIRING_OFFERS_DATABASE_FILE));
    assert.ok(![...opened.members.keys()].some(name => name.includes("owner-pairing")), "no journal member");
    for (const [, bytes] of opened.members) assert.ok(!bytes.includes(code), "no code in any member");
    assert.equal(opened.manifest.counts.appClients?.offers.open, 1);
  } finally { store.close(); }
});
