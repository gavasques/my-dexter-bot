import assert from "node:assert/strict";
import { createHash, createSecretKey } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect } from "node:tls";
import { test, type TestContext } from "node:test";
import { CLIENT_DEVICE_SCOPES, HostStore, type ClientDeviceScope } from "@dexter/hub";
import { createAuthorizedHostRouter, type HostOutputFilesPort, type HostRequestAuthority } from "@dexter/hub/http";
import { CLIENT_DEVICE_SCOPES as OPERATIONS_SCOPES, captureCheckpointArtifact, openCheckpointArtifact } from "@dexter/operations";
import { HostServices } from "../packages/cli/src/host-services.js";
import { call, clientIdentity, hostIdentity, type Trust } from "./app-client-lab.js";
import type { TlsIdentity } from "@dexter/devices";

// Paired access to a base's output folders: real HostServices + real mutual-TLS app-client listener (synthetic lab
// certificates, loopback, random port), real Hono router. No account, Keychain, TCC, SSH, provider or product port.
const OLD_SCOPES: ClientDeviceScope[] = ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read"];
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const OUTPUT_ROUTES: Array<[string, string]> = [["GET", "/v1/output-files/status"], ["GET", "/v1/output-files/locations"], ["GET", "/v1/output-files/namespaces"],
  ["GET", "/v1/output-files/entries?namespace=general"], ["GET", "/v1/output-files/item?namespace=general&path=x"],
  ["GET", `/v1/output-files/content?namespace=general&path=x&pin=${"0".repeat(64)}`], ["PUT", "/v1/output-files/destination"], ["GET", "/v1/output-files/receipts/any-id"]];

interface Lab { root: string; dataDir: string; services: HostServices; trust: Trust; botId: string; deck: Buffer;
  identity(label: string): TlsIdentity; pair(identity: TlsIdentity, scopes: readonly ClientDeviceScope[]): Promise<string>;
  raw(identity: TlsIdentity, method: string, path: string): Promise<{ status: number; body: Buffer }> }
async function lab(t: TestContext): Promise<Lab> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-output-paired-"))); chmodSync(root, 0o700);
  const host = hostIdentity(join(root, "id-host")), dataDir = join(root, "host");
  const services = new HostServices({ dataDir, appClients: { identity: host } });
  const url = await services.startAppClients();
  assert.ok(!/:4317$|:4318$/.test(url));
  t.after(async () => { await services.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const trust: Trust = { url, certPem: host.certPem, fingerprint: host.fingerprint };
  const bot = services.store.createBot({ name: "Relatórios", profileId: "synthetic", engine: "claude" });
  const folder = join(dataDir, "bot-files", bot.id);
  mkdirSync(join(folder, "slides"), { recursive: true, mode: 0o700 });
  const deck = Buffer.alloc(600 * 1024); for (let i = 0; i < deck.length; i++) deck[i] = (i * 7 + 3) % 253;
  writeFileSync(join(folder, "slides", "deck.pptx"), deck); writeFileSync(join(folder, "notes.txt"), "ok");
  writeFileSync(join(folder, ".env"), "SECRET_SENTINEL=1"); symlinkSync(root, join(folder, "escape"));
  let n = 0;
  return { root, dataDir, services, trust, botId: bot.id, deck,
    identity: label => clientIdentity(join(root, `id-${label}-${++n}`)),
    pair: async (identity, scopes) => {
      const bundle = services.appClientsAdmin.pairingBundle({ kind: "pair", role: "client-mac", scopes: [...scopes].sort() as ClientDeviceScope[] });
      const claimed = await call(trust, identity, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Mac sintético" });
      services.appClientsAdmin.approveClaim(claimed.json.claimId as string);
      const status = await call(trust, identity, "POST", "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
      assert.equal(status.json.status, "approved"); return status.json.deviceId as string;
    },
    // Binary-safe pinned mTLS GET (the lab `call` parses JSON).
    raw: (identity, method, path) => new Promise((resolve, reject) => {
      const u = new URL(url);
      const socket = connect({ host: u.hostname, port: Number(u.port), cert: identity.certPem, key: identity.keyPem, ca: [host.certPem], minVersion: "TLSv1.3",
        checkServerIdentity: () => undefined }, () => socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`));
      const chunks: Buffer[] = [];
      socket.on("data", c => chunks.push(c)); socket.on("error", reject);
      socket.on("end", () => {
        const all = Buffer.concat(chunks), split = all.indexOf("\r\n\r\n");
        resolve({ status: Number(all.subarray(9, 12).toString()), body: all.subarray(split + 4) });
      });
    }),
  };
}
const destination = (l: Lab, id: string, revision: number, path: string, host = l.services.store.hostId) =>
  ({ expectedHostID: host, clientRequestId: id, expectedRevision: revision, destination: { kind: "owner_path", path } });

test("closed scopes, denied by default: existing clients, rotation and unknown scopes get nothing", async t => {
  assert.deepEqual([...CLIENT_DEVICE_SCOPES], [...OPERATIONS_SCOPES], "Operations mirror is exact");
  assert.deepEqual(CLIENT_DEVICE_SCOPES.filter(s => s.startsWith("outputs.")), ["outputs.read", "outputs.manage"]);
  const l = await lab(t), phone = l.identity("phone");
  assert.throws(() => l.services.appClientsAdmin.pairingBundle({ kind: "pair", role: "client-mac", scopes: ["outputs.write"] as never }), (e: { code?: string }) => e.code === "invalid_input");
  const id = await l.pair(phone, OLD_SCOPES);
  const health = await call(l.trust, phone, "GET", "/health");
  assert.deepEqual(health.json.client, { deviceId: id, role: "client-mac", scopes: OLD_SCOPES, pinGeneration: 1, bindingRevision: 1 }, "no scope inferred");
  for (const [method, path] of OUTPUT_ROUTES) assert.equal((await call(l.trust, phone, method, path, method === "PUT" ? destination(l, "x", 1, l.root) : undefined)).status, 403, path);
  // Rotation keeps the approved scopes exactly; nothing is added.
  const rotated = l.identity("rotated"), bundle = l.services.appClientsAdmin.pairingBundle({ kind: "rotate", deviceId: id });
  assert.deepEqual(bundle.scopes, OLD_SCOPES);
  const claimed = await call(l.trust, rotated, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Ignored" });
  l.services.appClientsAdmin.approveClaim(claimed.json.claimId as string);
  await call(l.trust, rotated, "POST", "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
  assert.equal((await call(l.trust, rotated, "GET", "/v1/output-files/status")).status, 403);
  // Neither connections nor other owner-local administration is re-exposed by the new scopes.
  const reader = l.identity("reader"); await l.pair(reader, ["outputs.manage", "outputs.read"]);
  for (const path of ["/v1/connections/status", "/v1/mcp/servers", "/v1/browser-use/status", "/v1/memory-backend/status"])
    assert.ok([403, 404].includes((await call(l.trust, reader, "GET", path)).status), path);
});

test("outputs.read: bounded listing, no-follow, secrets hidden, 256 KiB pinned chunks; no destination or receipts", async t => {
  const l = await lab(t), reader = l.identity("reader");
  await l.pair(reader, ["outputs.read"]);
  const status = await call(l.trust, reader, "GET", "/v1/output-files/status");
  assert.equal(status.status, 200); assert.equal(status.json.hostId, l.services.store.hostId); assert.equal((status.json.current as { kind: string }).kind, "host_data_legacy");
  assert.equal((await call(l.trust, reader, "GET", "/v1/output-files/locations")).status, 200);
  const namespaces = await call(l.trust, reader, "GET", "/v1/output-files/namespaces");
  assert.deepEqual((namespaces.json.items as Array<{ ref: string; label: string }>).map(i => [i.ref, i.label]), [[`bot:${l.botId}`, "Relatórios"]]);
  const ns = encodeURIComponent(`bot:${l.botId}`);
  const entries = await call(l.trust, reader, "GET", `/v1/output-files/entries?namespace=${ns}`);
  assert.deepEqual((entries.json.items as Array<{ name: string; type: string }>).map(i => [i.name, i.type]), [["escape", "blocked"], ["notes.txt", "file"], ["slides", "directory"]]);
  assert.deepEqual(entries.json.hidden, { secretLike: 1, internal: 0 }); assert.ok(!JSON.stringify(entries.json).includes("SECRET_SENTINEL"));
  assert.equal((await call(l.trust, reader, "GET", `/v1/output-files/entries?namespace=${ns}&path=escape`)).status, 403);
  assert.equal((await call(l.trust, reader, "GET", `/v1/output-files/item?namespace=${ns}&path=.env`)).status, 403);
  const item = await call(l.trust, reader, "GET", `/v1/output-files/item?namespace=${ns}&path=slides%2Fdeck.pptx`);
  assert.equal(item.status, 200); assert.equal(item.json.sha256, sha(l.deck));
  const parts: Buffer[] = [];
  for (let offset = 0; offset < l.deck.length;) {
    const chunk = await l.raw(reader, "GET", `/v1/output-files/content?namespace=${ns}&path=slides%2Fdeck.pptx&pin=${item.json.pin}&offset=${offset}`);
    assert.equal(chunk.status, 200); assert.ok(chunk.body.length > 0 && chunk.body.length <= 262_144); parts.push(chunk.body); offset += chunk.body.length;
  }
  assert.equal(parts.length, 3); assert.equal(sha(Buffer.concat(parts)), sha(l.deck));
  assert.equal((await call(l.trust, reader, "GET", `/v1/output-files/content?namespace=${ns}&path=slides%2Fdeck.pptx&pin=${item.json.pin}&offset=0&length=262145`)).status, 400);
  assert.equal((await call(l.trust, reader, "GET", `/v1/output-files/content?namespace=${ns}&path=slides%2Fdeck.pptx&pin=${"0".repeat(64)}`)).status, 409);
  assert.equal((await call(l.trust, reader, "PUT", "/v1/output-files/destination", destination(l, "r-1", 1, l.root))).status, 403, "read never changes the destination");
  assert.equal((await call(l.trust, reader, "GET", "/v1/output-files/receipts/r-1")).status, 403, "receipts need outputs.manage");
  assert.ok([400, 403].includes((await call(l.trust, reader, "GET", "/v1/output-files/status", undefined, { headers: { origin: "https://evil.invalid" } })).status));
});

test("outputs.manage: CAS + receipt + replay, wrong host, lost ACK settled by GET only; no read without outputs.read", async t => {
  const l = await lab(t), manager = l.identity("manager"), chosen = realpathSync(mkdtempSync(join(tmpdir(), "dx-output-paired-dest-")));
  chmodSync(chosen, 0o700); t.after(() => rmSync(chosen, { recursive: true, force: true }));
  await l.pair(manager, ["outputs.manage"]);
  assert.equal((await call(l.trust, manager, "GET", "/v1/output-files/status")).status, 403, "manage is not read");
  assert.equal((await call(l.trust, manager, "PUT", "/v1/output-files/destination", destination(l, "m-1", 1, chosen, "other-host"))).status, 409, "wrong host");
  assert.equal((await call(l.trust, manager, "PUT", "/v1/output-files/destination", { ...destination(l, "m-1", 1, chosen), ownerId: "forged" })).status, 400, "body never carries authority");
  const first = await call(l.trust, manager, "PUT", "/v1/output-files/destination", destination(l, "m-1", 1, chosen));
  assert.equal(first.status, 200); assert.deepEqual([first.json.revision, first.json.generation, first.json.existingFilesMoved], [2, 2, false]);
  assert.deepEqual((await call(l.trust, manager, "PUT", "/v1/output-files/destination", destination(l, "m-1", 1, chosen))).json, first.json, "replay");
  assert.equal((await call(l.trust, manager, "PUT", "/v1/output-files/destination", { expectedHostID: l.services.store.hostId, clientRequestId: "m-1", expectedRevision: 1,
    destination: { kind: "host_data_default" } })).status, 409, "same id, other body");
  // Lost ACK: the response is discarded; the client only READS the original receipt (no second PUT, no new generation).
  void await call(l.trust, manager, "PUT", "/v1/output-files/destination", { expectedHostID: l.services.store.hostId, clientRequestId: "m-2", expectedRevision: 2, destination: { kind: "host_data_default" } });
  const recovered = await call(l.trust, manager, "GET", "/v1/output-files/receipts/m-2");
  assert.equal(recovered.status, 200); assert.equal(recovered.json.generation, 3);
  assert.equal((await call(l.trust, manager, "GET", "/v1/output-files/receipts/never")).status, 404);
  assert.equal(l.services.outputFilesHttp.status() && (l.services.outputFilesHttp.status() as { revision: number }).revision, 3, "exactly two changes");
});

test("authority is the current mTLS binding: revoked after the body await, stale rotated key, unpaired key → no effect", async t => {
  const l = await lab(t), manager = l.identity("manager"), stranger = l.identity("stranger");
  const id = await l.pair(manager, ["outputs.manage", "outputs.read"]);
  assert.equal((await call(l.trust, stranger, "GET", "/v1/output-files/status")).status, 403, "unpaired certificate");
  const u = new URL(l.trust.url), body = JSON.stringify(destination(l, "late", 1, l.root));
  const socket = connect({ host: u.hostname, port: Number(u.port), cert: manager.certPem, key: manager.keyPem, ca: [l.trust.certPem], minVersion: "TLSv1.3", checkServerIdentity: () => undefined });
  socket.on("error", () => {});
  await new Promise<void>(resolve => socket.once("secureConnect", () => resolve()));
  const reply = new Promise<string>(resolve => { let text = ""; socket.on("data", c => { text += c.toString(); }); socket.on("close", () => resolve(text)); });
  socket.write(`PUT /v1/output-files/destination HTTP/1.1\r\nHost: ${u.host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 10)}`);
  await new Promise(r => setTimeout(r, 150));
  l.services.peersHttp!.revoke(id);
  socket.write(body.slice(10));
  const text = await reply;
  assert.ok(!text.includes(" 200 "), "no success after revocation");
  assert.equal((l.services.outputFilesHttp.status() as { revision: number }).revision, 1, "no effect");
  assert.equal(l.services.outputFilesHttp.receipt("late"), null);
  assert.equal((await call(l.trust, manager, "GET", "/v1/output-files/status")).status, 403);
  // Stale generation: after an approved rotation the old key is refused.
  const other = l.identity("other"), newer = l.identity("newer"), otherId = await l.pair(other, ["outputs.read"]);
  const bundle = l.services.appClientsAdmin.pairingBundle({ kind: "rotate", deviceId: otherId });
  const claimed = await call(l.trust, newer, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Ignored" });
  l.services.appClientsAdmin.approveClaim(claimed.json.claimId as string);
  await call(l.trust, newer, "POST", "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
  assert.equal((await call(l.trust, other, "GET", "/v1/output-files/status")).status, 403);
  assert.equal((await call(l.trust, newer, "GET", "/v1/output-files/status")).status, 200);
});

test("router: the binding is re-checked after the body await and immediately before every effect", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dx-output-paired-router-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HostStore({ dataDir: dir }); t.after(() => store.close());
  const effects: string[] = [];
  const port: HostOutputFilesPort = { status: () => (effects.push("status"), {}), locations: () => ({}), namespaces: () => ({}), entries: () => ({}), item: () => ({}),
    content: () => (effects.push("content"), { bytes: new Uint8Array([1]), mediaType: "x", name: "x", size: 1, offset: 0 }),
    setDestination: () => (effects.push("destination"), {}), receipt: () => null };
  const router = createAuthorizedHostRouter(store, { outputFiles: port });
  const authority = (scopes: string[], validChecks: number): HostRequestAuthority => {
    let checks = 0;
    return { principal: "paired-client", installationId: store.hostId, ownerId: store.ownerId, deviceId: "device", role: "client-mac", scopes: scopes as never,
      pinGeneration: 1, bindingRevision: 1, noteSelfRevoke() {}, assertCurrent() { if (++checks > validChecks) throw new Error("revoked"); } } as HostRequestAuthority;
  };
  const put = (a: HostRequestAuthority) => router.request("/v1/output-files/destination", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }, { authority: a });
  assert.notEqual((await put(authority(["outputs.manage"], 1))).status, 200, "revoked during the body await");
  assert.notEqual((await router.request(`/v1/output-files/content?namespace=general&path=x&pin=${"0".repeat(64)}`, {}, { authority: authority(["outputs.read"], 1) })).status, 200);
  assert.deepEqual(effects, [], "no effect after the binding changed");
  assert.equal((await router.request("/v1/output-files/status", {}, { authority: authority(["outputs.manage"], 9) })).status, 403, "exact scope");
  assert.equal((await router.request("/v1/output-files/status", {}, { authority: authority(["outputs.read"], 9) })).status, 200);
  assert.equal((await put(authority(["outputs.read"], 9))).status, 403);
  assert.deepEqual(effects, ["status"]);
  const noPort = createAuthorizedHostRouter(store, {});
  assert.equal((await noPort.request("/v1/output-files/status", {}, { authority: authority(["outputs.read"], 9) })).status, 503, "no other base behind it");
});

test("Operations: checkpoint carries enrollments with the new scopes exactly and refuses an unknown scope", async t => {
  const capture = async (tamper: boolean): Promise<string | null> => {
    const l = await lab(t), phone = l.identity("phone");
    await l.pair(phone, ["chat.read", "outputs.manage", "outputs.read"]);
    await l.services.shutdown();
    if (tamper) {
      const db = new DatabaseSync(join(l.dataDir, "dexter.sqlite"));
      // Only the data is tampered: the immutable-row trigger is restored byte-for-byte, so the schema stays canonical.
      const trigger = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='client_enrollment_no_update'").get() as { sql: string }).sql;
      db.exec("DROP TRIGGER client_enrollment_no_update; UPDATE client_device_enrollments SET scopes = '[\"chat.read\",\"outputs.read\",\"outputs.write\"]';");
      db.exec(trigger);
      db.close();
    }
    const out = realpathSync(mkdtempSync(join(tmpdir(), "dx-output-paired-ckp-"))); t.after(() => rmSync(out, { recursive: true, force: true }));
    let store: HostStore | null = null;
    try {
      store = new HostStore({ dataDir: l.dataDir });
      const checkpoint = store.checkpointForTransfer("ckp_output_paired_scopes_2026");
      const key = { keyId: "synthetic-scopes", use: <T>(fn: (k: ReturnType<typeof createSecretKey>) => T) => fn(createSecretKey(Buffer.alloc(32, 9))) };
      const artifact = captureCheckpointArtifact({ source: store, checkpoint, key, output: join(out, "a.dxg8") });
      const opened = openCheckpointArtifact(artifact.path, key);
      return JSON.stringify(opened.manifest.coverage);
    } catch (error) {
      const code = (error as { code?: string }).code, message = (error as Error).message;
      // The tampered enrollment must be refused by the exact scope validators, nothing else.
      if (tamper && /scope|enrollment/i.test(message) && code) return null;
      return `${code}: ${message}`;
    }
    finally { try { store?.close(); } catch { /* closed */ } }
  };
  const ok = await capture(false);
  assert.ok(ok && ok.includes("appClients"), String(ok));
  assert.equal(await capture(true), null, "unknown scope refused by the exact validators");
});
