import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { test, type TestContext } from "node:test";
import { OUTPUT_FILES_LIMITS, OUTPUT_REMOTE_BROWSING, OutputFilesStatusSchema } from "@dexter/contracts";
import type { ClientDeviceScope } from "@dexter/hub";
import type { TlsIdentity } from "@dexter/devices";
import { HostServices } from "../packages/cli/src/host-services.js";
import { call, clientIdentity, hostIdentity, type Trust } from "./app-client-lab.js";
const { PAIRED_OUTPUT_CHUNK_BYTES } = await import(new URL("../../packages/hub/dist/http-routes.js", import.meta.url).href) as { PAIRED_OUTPUT_CHUNK_BYTES: number };

// `status.scope.remoteBrowsing` states the REAL composition: owner loopback only without the paired app-client channel;
// owner loopback + paired clients with the exact owner-granted scope when it is composed. Never relayed. Real HostServices,
// real mutual-TLS listener (lab certificates, loopback, random port), synthetic data only.
const LEGACY: ClientDeviceScope[] = ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read"];
const golden = JSON.parse(readFileSync(new URL("../../apps/apple/Tests/DexterHostClientTests/Fixtures/output-files-status-golden.json", import.meta.url), "utf8")) as
  { current: Record<string, Record<string, unknown>>; legacy: Record<string, Record<string, unknown>> };
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const edit = (value: Record<string, unknown>, section: "scope" | "limits", key: string, replacement: unknown) => {
  const inner = { ...(value[section] as Record<string, unknown>) };
  if (replacement === undefined) delete inner[key]; else inner[key] = replacement;
  return { ...value, [section]: inner };
};

async function paired(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-output-contract-"))); chmodSync(root, 0o700);
  const host = hostIdentity(join(root, "id-host")), dataDir = join(root, "host");
  const services = new HostServices({ dataDir, appClients: { identity: host } });
  const url = await services.startAppClients();
  assert.ok(!/:4317$|:4318$/.test(url));
  t.after(async () => { await services.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const trust: Trust = { url, certPem: host.certPem, fingerprint: host.fingerprint };
  const bot = services.store.createBot({ name: "Relatórios", profileId: "synthetic", engine: "claude" });
  const folder = join(dataDir, "bot-files", bot.id); mkdirSync(folder, { recursive: true, mode: 0o700 });
  const deck = Buffer.alloc(OUTPUT_FILES_LIMITS.pairedChunkBytes + 1000); for (let i = 0; i < deck.length; i++) deck[i] = (i * 11 + 1) % 251;
  writeFileSync(join(folder, "deck.pptx"), deck);
  let n = 0;
  const pair = async (scopes: readonly ClientDeviceScope[]) => {
    const identity = clientIdentity(join(root, `id-client-${++n}`));
    const bundle = services.appClientsAdmin.pairingBundle({ kind: "pair", role: "client-mac", scopes: [...scopes].sort() as ClientDeviceScope[] });
    const claimed = await call(trust, identity, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Mac sintético" });
    services.appClientsAdmin.approveClaim(claimed.json.claimId as string);
    const status = await call(trust, identity, "POST", "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
    assert.equal(status.json.status, "approved"); return { identity, deviceId: status.json.deviceId as string };
  };
  const raw = (identity: TlsIdentity, path: string) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const u = new URL(url);
    const socket = connect({ host: u.hostname, port: Number(u.port), cert: identity.certPem, key: identity.keyPem, ca: [host.certPem], minVersion: "TLSv1.3",
      checkServerIdentity: () => undefined }, () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`));
    const chunks: Buffer[] = []; socket.on("data", c => chunks.push(c)); socket.on("error", reject);
    socket.on("end", () => { const all = Buffer.concat(chunks), split = all.indexOf("\r\n\r\n"); resolve({ status: Number(all.subarray(9, 12).toString()), body: all.subarray(split + 4) }); });
  });
  return { root, services, trust, botId: bot.id, deck, pair, raw };
}

test("contract: closed remote-browsing enum, additive nullable fields, legacy payloads still parse, inconsistency refused", () => {
  assert.deepEqual([...OUTPUT_REMOTE_BROWSING], ["owner_loopback_only", "owner_loopback_and_paired_scoped"]);
  assert.equal(OUTPUT_FILES_LIMITS.pairedChunkBytes, PAIRED_OUTPUT_CHUNK_BYTES, "the contract states the listener's real chunk cap");
  assert.equal(OUTPUT_FILES_LIMITS.chunkBytes, 8 * 1024 * 1024);
  for (const [name, value] of Object.entries(golden.legacy)) {
    const parsed = OutputFilesStatusSchema.parse(value);
    assert.equal(parsed.scope.remoteBrowsing, "owner_loopback_only", name); assert.equal(parsed.scope.relayedBrowsing, undefined); assert.equal(parsed.limits.pairedChunkBytes, undefined);
  }
  for (const value of Object.values(golden.current)) OutputFilesStatusSchema.parse(value);
  const pairedStatus = golden.current.pairedComposedOwner!, loopback = golden.current.ownerLoopbackOnly!;
  for (const [label, value] of [
    ["unknown value", edit(pairedStatus, "scope", "remoteBrowsing", "owner_loopback_and_relay")],
    ["relayed claim", edit(pairedStatus, "scope", "remoteBrowsing", "relayed")],
    ["missing value", edit(pairedStatus, "scope", "remoteBrowsing", undefined)],
    ["relayed browsing", edit(pairedStatus, "scope", "relayedBrowsing", "relayed")],
    ["paired without chunk", edit(pairedStatus, "limits", "pairedChunkBytes", null)],
    ["chunk above the cap", edit(pairedStatus, "limits", "pairedChunkBytes", PAIRED_OUTPUT_CHUNK_BYTES + 1)],
    ["loopback-only with chunk", edit(loopback, "limits", "pairedChunkBytes", PAIRED_OUTPUT_CHUNK_BYTES)],
    ["extra scope key", edit(loopback, "scope", "relay", "available")],
  ] as const) assert.equal(OutputFilesStatusSchema.safeParse(value).success, false, label);
});

test("real host without the paired channel: owner loopback only, no paired chunk, never relayed", async t => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "dx-output-contract-plain-"))); chmodSync(dataDir, 0o700);
  const services = new HostServices({ dataDir });
  t.after(async () => { await services.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  const status = OutputFilesStatusSchema.parse(services.outputFilesHttp.status());
  assert.equal(status.scope.remoteBrowsing, "owner_loopback_only"); assert.equal(status.scope.relayedBrowsing, "not_relayed");
  assert.equal(status.limits.pairedChunkBytes, null); assert.equal(status.limits.chunkBytes, 8 * 1024 * 1024);
});

test("paired composition over real mTLS: the client reads the real policy, chained read → manage with exact scopes, replay/lost ACK by GET only", async t => {
  const l = await paired(t);
  const owner = OutputFilesStatusSchema.parse(l.services.outputFilesHttp.status());
  assert.equal(owner.scope.remoteBrowsing, "owner_loopback_and_paired_scoped"); assert.equal(owner.limits.pairedChunkBytes, PAIRED_OUTPUT_CHUNK_BYTES);
  // Old 8: still valid, nothing about outputs inferred.
  const legacy = await l.pair(LEGACY);
  assert.deepEqual((await call(l.trust, legacy.identity, "GET", "/health")).json.client, { deviceId: legacy.deviceId, role: "client-mac", scopes: LEGACY, pinGeneration: 1, bindingRevision: 1 });
  assert.equal((await call(l.trust, legacy.identity, "GET", "/v1/output-files/status")).status, 403);
  // All 10, explicit: one client chains read → manage, each route gated by its exact scope.
  const both = await l.pair([...LEGACY, "outputs.manage", "outputs.read"]);
  const remote = await call(l.trust, both.identity, "GET", "/v1/output-files/status");
  assert.equal(remote.status, 200); assert.deepEqual(OutputFilesStatusSchema.parse(remote.json), owner, "same payload as the owner reads");
  const ns = encodeURIComponent(`bot:${l.botId}`);
  const item = await call(l.trust, both.identity, "GET", `/v1/output-files/item?namespace=${ns}&path=deck.pptx`);
  const at = (offset: number, length: number) => l.raw(both.identity, `/v1/output-files/content?namespace=${ns}&path=deck.pptx&pin=${item.json.pin}&offset=${offset}&length=${length}`);
  const first = await at(0, owner.limits.pairedChunkBytes!), rest = await at(owner.limits.pairedChunkBytes!, owner.limits.pairedChunkBytes!);
  assert.equal(first.status, 200); assert.equal(first.body.length, PAIRED_OUTPUT_CHUNK_BYTES); assert.equal(rest.body.length, 1000);
  assert.equal(sha(Buffer.concat([first.body, rest.body])), sha(l.deck));
  assert.equal((await at(0, owner.limits.pairedChunkBytes! + 1)).status, 400, "the advertised cap is the enforced cap");
  const chosen = realpathSync(mkdtempSync(join(tmpdir(), "dx-output-contract-dest-"))); chmodSync(chosen, 0o700); t.after(() => rmSync(chosen, { recursive: true, force: true }));
  const input = { expectedHostID: owner.hostId, clientRequestId: "contract-1", expectedRevision: owner.revision, destination: { kind: "owner_path", path: chosen } };
  void await call(l.trust, both.identity, "PUT", "/v1/output-files/destination", input); // response treated as lost
  const receipt = await call(l.trust, both.identity, "GET", "/v1/output-files/receipts/contract-1");
  assert.equal(receipt.status, 200); assert.equal(receipt.json.revision, 2);
  assert.deepEqual((await call(l.trust, both.identity, "PUT", "/v1/output-files/destination", input)).json, receipt.json, "replay returns the original receipt");
  assert.equal(OutputFilesStatusSchema.parse(l.services.outputFilesHttp.status()).revision, 2, "no repeated action");
  // Exact scope per link of the chain.
  const reader = await l.pair(["outputs.read"]), manager = await l.pair(["outputs.manage"]);
  assert.equal((await call(l.trust, reader.identity, "GET", "/v1/output-files/status")).status, 200);
  assert.equal((await call(l.trust, reader.identity, "GET", "/v1/output-files/receipts/contract-1")).status, 403);
  assert.equal((await call(l.trust, manager.identity, "GET", "/v1/output-files/status")).status, 403);
  assert.equal((await call(l.trust, manager.identity, "GET", "/v1/output-files/receipts/contract-1")).status, 200);
  // Revoked: the next link is refused with no effect.
  l.services.peersHttp!.revoke(both.deviceId);
  assert.equal((await call(l.trust, both.identity, "GET", "/v1/output-files/status")).status, 403);
  assert.equal((await call(l.trust, both.identity, "PUT", "/v1/output-files/destination", { ...input, clientRequestId: "contract-2", expectedRevision: 2 })).status, 403);
  assert.equal(OutputFilesStatusSchema.parse(l.services.outputFilesHttp.status()).revision, 2);
});
