// Real loopback TLS 1.3 app-client listener over a real HostStore + ConversationRuntime (fake engine driver).
// Covers authentication, pairing, scope enforcement, forbidden routes, revocation/rotation and drain.
import assert from "node:assert/strict";
import { connect } from "node:tls";
import test from "node:test";
import { DeviceInputSchema } from "@dexter/contracts";
import { ALL_SCOPES, appLab, call, pairClient, type AppLab } from "./app-client-lab.js";

const until = async (check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 20)); }
};
const errorOf = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; return "resolved"; } catch (error) { return (error as NodeJS.ErrnoException).code ?? (error as Error).message; }
};

test("unknown, missing or wrong-protocol peers get no admitted operation; pinned hostname is enforced", async (t) => {
  const l = await appLab(t);
  const stranger = l.identity("stranger");
  assert.deepEqual((await call(l.trust, stranger, "GET", "/health")).status, 403);
  assert.equal((await call(l.trust, stranger, "GET", "/v1/bots")).status, 403);
  assert.equal((await call(l.trust, stranger, "POST", "/v1/bots", { name: "x", profileId: "p", engine: "codex" })).status, 403);
  assert.notEqual(await errorOf(call(l.trust, null, "GET", "/health")), "resolved", "no client certificate");
  assert.notEqual(await errorOf(call(l.trust, stranger, "GET", "/health", undefined, { maxVersion: "TLSv1.2" })), "resolved", "TLS 1.2");
  assert.equal(await errorOf(call({ ...l.trust, fingerprint: "0".repeat(64) }, stranger, "GET", "/health")), "pin mismatch");
  assert.equal(await errorOf(call(l.trust, stranger, "GET", "/health", undefined, { servername: "evil.example" })), "ERR_TLS_CERT_ALTNAME_INVALID");
  // Wrong Host header (DNS rebinding / proxy confusion) is refused before routing.
  assert.equal((await call(l.trust, stranger, "GET", "/health", undefined, { host: "localhost:1" })).status, 421);
  assert.equal(l.store.listBots().length, 0);
});

test("pairing: closed claim body, pending denial, owner approval, zero bots/actions/grants by pairing alone", async (t) => {
  const l = await appLab(t);
  const phone = l.identity("phone");
  const bundle = l.services.admin.pairingBundle({ kind: "pair", role: "client-ios", scopes: ["chat.read", "chat.write"] });
  assert.equal(bundle.protocol, "dexter-app-client-v1"); assert.equal(bundle.hostUrl, l.trust.url);
  assert.equal(bundle.hostFingerprint, l.host.fingerprint); assert.equal(bundle.installationId, l.store.hostId);
  for (const extra of [{ role: "client-mac" }, { scopes: ["devices.manage"] }, { ownerId: "own_x" }, { deviceId: "dev_x" }, { capabilities: ["file.append"] }, { platform: "macos" }]) {
    const forged = await call(l.trust, phone, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "P", ...extra });
    assert.equal(forged.status, 400, JSON.stringify(extra));
  }
  const claimed = await call(l.trust, phone, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Lab iPhone" });
  assert.equal(claimed.status, 200);
  const claimId = claimed.json.claimId as string;
  assert.equal((await call(l.trust, phone, "GET", "/v1/bots")).status, 403, "pending claim is not authority");
  assert.equal((await call(l.trust, l.identity("other"), "POST", "/app-client/v1/pair/status", { claimId })).status, 404, "status bound to claimant pin");
  assert.equal((await call(l.trust, phone, "POST", "/app-client/v1/pair/status", { claimId })).json.status, "pending");
  const replay = await call(l.trust, l.identity("thief"), "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "T" });
  assert.deepEqual(replay, { status: 403, json: { error: "forbidden" } });
  const [pending] = l.services.admin.pendingClaims();
  assert.equal(pending!.clientFingerprint, phone.fingerprint); assert.deepEqual(pending!.scopes, ["chat.read", "chat.write"]);
  l.services.admin.approveClaim(claimId);
  const status = await call(l.trust, phone, "POST", "/app-client/v1/pair/status", { claimId });
  assert.equal(status.json.status, "approved"); assert.equal(status.json.installationId, l.store.hostId);
  assert.equal(status.json.ownerId, l.store.ownerId); assert.equal(status.json.role, "client-ios");
  assert.deepEqual([status.json.pinGeneration, status.json.bindingRevision], [1, 1]);
  const health = await call(l.trust, phone, "GET", "/health");
  assert.equal(health.json.mode, "paired-client"); assert.equal(health.json.remotePairing, "implemented");
  assert.equal("state" in health.json, false, "no host state/lease to clients");
  assert.deepEqual(await call(l.trust, phone, "GET", "/v1/bots"), { status: 200, json: { items: [], nextCursor: null } });
  assert.equal(l.store.listActions().length, 0);
  const device = l.store.getDevice(status.json.deviceId as string);
  assert.deepEqual([device.platform, device.capabilities], ["ios", []]);
  assert.equal(DeviceInputSchema.safeParse({ name: device.name, platform: device.platform, capabilities: device.capabilities }).success, true);
});

test("paired iPhone runs the chat API with idempotent turns, polling deltas and canonical messages", async (t) => {
  const l = await appLab(t);
  const phone = l.identity("phone");
  await pairClient(l, phone);
  const bot = await call(l.trust, phone, "POST", "/v1/bots", { name: "General", profileId: "personal", engine: "codex" });
  assert.equal(bot.status, 201); assert.equal(bot.json.ownerId, l.store.ownerId);
  assert.equal((await call(l.trust, phone, "POST", "/v1/bots", { name: "G", profileId: "p", engine: "codex", ownerId: "own_evil" })).status, 400);
  const thread = await call(l.trust, phone, "POST", `/v1/bots/${bot.json.id}/threads`, {});
  assert.equal(thread.status, 201);
  const input = { clientRequestId: "remote-turn-1", content: "Oi." };
  const started = await call(l.trust, phone, "POST", `/v1/threads/${thread.json.id}/turns`, input);
  assert.equal(started.status, 201);
  const replay = await call(l.trust, phone, "POST", `/v1/threads/${thread.json.id}/turns`, input);
  assert.deepEqual([replay.status, replay.json.id], [200, started.json.id]);
  await until(async () => (await call(l.trust, phone, "GET", `/v1/turns/${started.json.id}`)).json.state === "completed");
  const events = await call(l.trust, phone, "GET", `/v1/turns/${started.json.id}/events?limit=100`);
  assert.equal((events.json.items as { text: string | null }[]).map((e) => e.text ?? "").join(""), "Olá, Dexter.");
  assert.equal((await call(l.trust, phone, "GET", `/v1/turns/${started.json.id}/events?limit=500`)).status, 400, "remote page bound");
  const messages = await call(l.trust, phone, "GET", `/v1/threads/${thread.json.id}/messages?limit=100`);
  assert.equal((messages.json.items as { content: string }[]).at(-1)!.content, "Olá, Dexter.");
  for (let i = 0; i < 3; i++) await call(l.trust, phone, "POST", "/v1/bots", { name: `B${i}`, profileId: "p", engine: "codex" });
  const first = await call(l.trust, phone, "GET", "/v1/bots?limit=2");
  assert.equal(first.json.items!.length, 2); assert.equal(typeof first.json.nextCursor, "string");
  const rest = await call(l.trust, phone, "GET", `/v1/bots?limit=2&after=${first.json.nextCursor}`);
  assert.deepEqual([rest.json.items!.length, rest.json.nextCursor], [2, null]);
  assert.equal((await call(l.trust, phone, "GET", "/v1/bots?after=bot_missing")).status, 400, "unknown cursor never restarts");
});

test("scopes are exact per route; raw action/dispatch/enrollment/agent routes are refused for clients", async (t) => {
  const l = await appLab(t);
  const reader = l.identity("reader");
  await pairClient(l, reader, "client-mac", ["chat.read"]);
  const bot = l.store.createBot({ name: "B", profileId: "p", engine: "codex" });
  const thread = l.store.createThread(bot.id);
  assert.equal((await call(l.trust, reader, "GET", `/v1/bots/${bot.id}`)).status, 200);
  assert.equal((await call(l.trust, reader, "POST", "/v1/bots", { name: "x", profileId: "p", engine: "codex" })).status, 403);
  assert.equal((await call(l.trust, reader, "GET", "/v1/actions")).status, 403);
  assert.equal((await call(l.trust, reader, "GET", "/v1/devices")).status, 403);
  assert.equal((await call(l.trust, reader, "GET", "/v1/device-grants?botId=" + bot.id)).status, 403);
  const admin = l.identity("admin");
  const adminId = await pairClient(l, admin, "client-ios", ALL_SCOPES);
  const request = { botId: bot.id, threadId: thread.id, tool: "file.append", destination: adminId, arguments: {}, idempotencyKey: "k1" };
  const raw = [
    ["POST", "/v1/actions", request], ["POST", "/v1/devices", { name: "Fake", platform: "macos", capabilities: ["file.append"] }],
    ["POST", `/v1/devices/${adminId}/heartbeat`, {}],
  ] as const;
  for (const [method, path, body] of raw) assert.equal((await call(l.trust, admin, method, path, body)).status, 403, path);
  // A grant-gated legacy owner destination supplies a known action without making the client an executor.
  l.store.setGrant({ botId: bot.id, tool: "file.append", destination: "mac-local", policy: "allow" });
  const action = l.store.requestAction({ ...request, destination: "mac-local" });
  const counts = l.store.summary().counts;
  assert.equal((await call(l.trust, admin, "POST", `/v1/actions/${action.id}/dispatch`, {})).status, 403, "known id, client certificate");
  assert.equal(l.store.getAction(action.id).state, "ready");
  assert.deepEqual(l.store.summary().counts, counts);
  for (const path of ["/v1/device/poll", "/v1/device/receipt", "/v1/pair/claim", "/app-client/v1/unknown"]) {
    assert.equal((await call(l.trust, admin, "POST", path, { deviceId: adminId, installationId: l.store.hostId, receipts: [] })).status, 404, path);
  }
  assert.equal(l.store.getDevice(adminId).capabilities.length, 0);
  assert.equal(l.store.listActions().length, 1);
});

test("ambient/proxy headers, non-JSON, chunked and oversized bodies are refused before any effect", async (t) => {
  const l = await appLab(t);
  const phone = l.identity("phone");
  await pairClient(l, phone);
  const body = { name: "x", profileId: "p", engine: "codex" };
  for (const header of ["origin", "cookie", "authorization", "x-forwarded-for", "forwarded", "x-forwarded-host"]) {
    assert.equal((await call(l.trust, phone, "POST", "/v1/bots", body, { headers: { [header]: "https://127.0.0.1" } })).status, 400, header);
  }
  assert.equal((await call(l.trust, phone, "POST", "/v1/bots", body, { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await call(l.trust, phone, "POST", "/v1/bots", undefined, { rawBody: "x".repeat(300_000) })).status, 413);
  assert.equal((await call(l.trust, phone, "POST", "/v1/bots", undefined, { rawBody: "{", })).status, 400);
  assert.equal((await call(l.trust, phone, "GET", "/v1/bots/../health")).status, 400);
  // Transfer-Encoding: chunked without Content-Length.
  const chunked = await new Promise<string>((resolve, reject) => {
    const url = new URL(l.trust.url);
    const socket = connect({ host: url.hostname, port: Number(url.port), cert: phone.certPem, key: phone.keyPem, ca: [l.host.certPem],
      minVersion: "TLSv1.3", checkServerIdentity: () => undefined }, () => {
      socket.write(`POST /v1/bots HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n0\r\n\r\n`);
    });
    let data = ""; socket.on("data", (d) => { data += d.toString(); }); socket.on("end", () => resolve(data)); socket.on("error", reject);
  });
  assert.match(chunked, /^HTTP\/1\.1 400/);
  assert.equal(l.store.listBots().length, 0);
});

test("a resumed TLS session is never served: every admitted request carries a full client-certificate handshake", async (t) => {
  const l = await appLab(t);
  const phone = l.identity("phone");
  await pairClient(l, phone);
  const url = new URL(l.trust.url);
  const open = (session?: Buffer) => new Promise<{ reused: boolean; response: string; session: Buffer | undefined }>((resolve, reject) => {
    let saved: Buffer | undefined, reused = false;
    const socket = connect({ host: url.hostname, port: Number(url.port), cert: phone.certPem, key: phone.keyPem, ca: [l.host.certPem], minVersion: "TLSv1.3",
      checkServerIdentity: () => undefined, ...(session ? { session } : {}) }, () => {
      reused = socket.isSessionReused();
      socket.write(`GET /health HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
    });
    socket.on("session", (s: Buffer) => { saved = s; });
    let data = ""; socket.on("data", (d) => { data += d.toString(); });
    socket.on("close", () => resolve({ reused, response: data, session: saved }));
    socket.on("error", () => {}); void reject;
  });
  const first = await open();
  assert.match(first.response, /^HTTP\/1\.1 200/);
  assert.ok(first.session, "the client holds a resumable session");
  const second = await open(first.session);
  // Observed: the server does not resume (full handshake again). Were it ever resumed, it must not be served.
  if (second.reused) assert.equal(second.response, "", "a resumed session is destroyed before routing");
  else assert.match(second.response, /^HTTP\/1\.1 200/, "the offered session was not resumed; a full handshake was served");
  assert.equal(second.reused, false);
});

test("presence, rename and revocation through the unified projection; self-revoke gets one minimal ACK", async (t) => {
  const l = await appLab(t);
  const phone = l.identity("phone"), mac = l.identity("mac");
  const phoneId = await pairClient(l, phone);
  const macId = await pairClient(l, mac, "client-mac", ALL_SCOPES, "Lab Mac app");
  assert.equal((await call(l.trust, phone, "POST", "/app-client/v1/presence", { state: "foreground", deviceId: macId })).status, 400);
  assert.deepEqual((await call(l.trust, phone, "POST", "/app-client/v1/presence", { state: "foreground" })).json, { deviceId: phoneId, presence: "online" });
  const list = await call(l.trust, mac, "GET", "/v1/devices");
  const views = list.json.items as { id: string; role: string; presence: string; paired: boolean; capabilities: string[] }[];
  assert.deepEqual(views.map((v) => [v.id, v.role, v.paired, v.capabilities.length]), [[phoneId, "client-ios", true, 0], [macId, "client-mac", true, 0]]);
  assert.equal(views[0]!.presence, "online");
  const renamed = await call(l.trust, mac, "PATCH", `/v1/devices/${phoneId}`, { name: "Renamed" });
  assert.deepEqual([renamed.json.name, renamed.json.role], ["Renamed", "client-ios"]);
  assert.equal((await call(l.trust, mac, "PATCH", `/v1/devices/${phoneId}`, { name: "x", role: "agent-mac" })).status, 400);
  const revoked = await call(l.trust, mac, "POST", `/v1/devices/${phoneId}/revoke`, {});
  assert.deepEqual([revoked.status, revoked.json.presence, revoked.json.paired], [200, "revoked", false]);
  assert.equal((await call(l.trust, phone, "GET", "/v1/bots")).status, 403);
  assert.equal((await call(l.trust, phone, "GET", "/health")).status, 403);
  const self = await call(l.trust, mac, "POST", `/v1/devices/${macId}/revoke`, {});
  assert.deepEqual(self, { status: 200, json: { deviceId: macId, status: "revoked" } }, "only the minimal ACK, no projection data");
  assert.equal((await call(l.trust, mac, "GET", "/v1/devices")).status, 403);
  assert.notEqual(l.store.getDevice(macId).revokedAt, null);
  // Re-pairing the same key is refused; a new pairing is a new id with nothing restored.
  const bundle = l.services.admin.pairingBundle({ kind: "pair", role: "client-ios", scopes: [] });
  assert.equal((await call(l.trust, phone, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Again" })).status, 403);
});

test("revocation during a body read or before the response withholds data and admits nothing", async (t) => {
  const l = await appLab(t);
  const phone = l.identity("phone"), admin = l.identity("admin");
  const phoneId = await pairClient(l, phone);
  await pairClient(l, admin);
  const url = new URL(l.trust.url);
  const body = JSON.stringify({ name: "Late", profileId: "p", engine: "codex" });
  const reply = new Promise<string>((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port), cert: phone.certPem, key: phone.keyPem, ca: [l.host.certPem], minVersion: "TLSv1.3",
      checkServerIdentity: () => undefined }, () => {
      socket.write(`POST /v1/bots HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 10)}`);
      void until(() => l.services.status().inFlight === 1).then(async () => {
        await call(l.trust, admin, "POST", `/v1/devices/${phoneId}/revoke`, {});
        if (!socket.destroyed) socket.write(body.slice(10));
      });
    });
    let data = ""; socket.on("data", (d) => { data += d.toString(); });
    socket.on("close", () => resolve(data)); socket.on("error", () => {});
  });
  const text = await reply;
  assert.equal(/HTTP\/1\.1 200|HTTP\/1\.1 201/.test(text), false);
  assert.equal(l.store.listBots().length, 0, "no bot created after the revocation");
});

test("approved rotation keeps the id and invalidates the old key; restart keeps id/pin/role", async (t) => {
  const l = await appLab(t);
  const oldKey = l.identity("old"), newKey = l.identity("new");
  const id = await pairClient(l, oldKey, "client-ios", ["chat.read"]);
  const bundle = l.services.admin.pairingBundle({ kind: "rotate", deviceId: id });
  assert.deepEqual([bundle.kind, bundle.role, bundle.scopes, bundle.deviceId], ["rotate", "client-ios", ["chat.read"], id]);
  const claimed = await call(l.trust, newKey, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Ignored" });
  l.services.admin.approveClaim(claimed.json.claimId as string);
  const status = await call(l.trust, newKey, "POST", "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
  assert.deepEqual([status.json.deviceId, status.json.pinGeneration, status.json.bindingRevision], [id, 2, 2]);
  assert.equal((await call(l.trust, oldKey, "GET", "/health")).status, 403);
  const health = await call(l.trust, newKey, "GET", "/health");
  assert.deepEqual(health.json.client, { deviceId: id, role: "client-ios", scopes: ["chat.read"], pinGeneration: 2, bindingRevision: 2 });
});

test("close drains an in-flight request before releasing the registry; retained admin is refused", async (t) => {
  const l: AppLab = await appLab(t);
  const phone = l.identity("phone");
  await pairClient(l, phone);
  const url = new URL(l.trust.url);
  const socket = connect({ host: url.hostname, port: Number(url.port), cert: phone.certPem, key: phone.keyPem, ca: [l.host.certPem], minVersion: "TLSv1.3",
    checkServerIdentity: () => undefined });
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("secureConnect", () => resolve()));
  socket.write(`POST /v1/bots HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await until(() => l.services.status().inFlight === 1);
  let closed = false;
  const closing = l.services.close().then(() => { closed = true; });
  assert.throws(() => l.services.admin.pendingClaims(), /closing/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed, false, "close waits for the admitted handler");
  socket.destroy();
  await closing;
  assert.equal(closed, true);
  assert.equal(l.store.listBots().length, 0);
  await assert.rejects(l.services.start(), /closing/);
});
