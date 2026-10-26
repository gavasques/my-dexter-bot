// HostServices composition of the app-client channel (staged with the private HostServices patch): pure preflight,
// one writer shared with the Mac agent channel, local projection, and a shutdown that retains the writer until
// every admitted app-client request drained. Synthetic loopback identities only; engines disabled.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:tls";
import test from "node:test";
import { HostError, HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import { generateSyntheticIdentity } from "@dexter/devices";
import { HostServices } from "../packages/cli/src/host-services.js";
import { call, clientIdentity, hostIdentity, removeDir, tempDir } from "./app-client-lab.js";

test("app-client preflight is pure: invalid identity/origin/listen refuse before any canonical file", (t) => {
  const root = tempDir("dexter-host-app-pre-"); t.after(() => removeDir(root));
  const good = hostIdentity(join(root, "host-id"));
  const noSan = generateSyntheticIdentity(join(root, "nosan"), "nosan");
  for (const appClients of [{ identity: noSan }, { identity: good, listenHost: "0.0.0.0" }, { identity: good, listenHost: "example.com" },
    { identity: good, advertisedOrigin: "https://dexter.example:443" }, { identity: good, advertisedOrigin: "http://127.0.0.1:1" },
    { identity: good, advertisedOrigin: "https://127.0.0.1:1/path" }, { identity: good, port: 70000 }]) {
    const dataDir = join(root, "absent");
    assert.throws(() => new HostServices({ dataDir, appClients: appClients as never }), HostError, JSON.stringify(Object.keys(appClients)));
    assert.equal(existsSync(dataDir), false);
  }
});

test("one HostServices writer serves agent and app-client listeners; shutdown drains admitted requests before release", async (t) => {
  const root = tempDir("dexter-host-app-"); t.after(() => removeDir(root));
  const appHost = hostIdentity(join(root, "app-id"));
  const agentHost = generateSyntheticIdentity(join(root, "agent-id"), "agent");
  const dataDir = join(root, "host");
  const services = new HostServices({ dataDir, devices: { identity: agentHost, pollWaitMs: 50 }, appClients: { identity: appHost } });
  await services.startDevices();
  const url = await services.startAppClients();
  const trust = { url, certPem: appHost.certPem, fingerprint: appHost.fingerprint };
  const phone = clientIdentity(join(root, "phone"));
  const bundle = services.appClientsAdmin.pairingBundle({ kind: "pair", role: "client-ios", scopes: ["chat.read", "chat.write", "devices.read"] });
  const claimed = await call(trust, phone, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Lab iPhone" });
  const { deviceId } = services.appClientsAdmin.approveClaim(claimed.json.claimId as string);
  assert.equal((await call(trust, phone, "POST", "/v1/bots", { name: "B", profileId: "p", engine: "codex" })).status, 201);
  assert.equal((await call(trust, phone, "POST", `/v1/threads/thr_x/turns`, { clientRequestId: "x", content: "x" })).status, 503, "engines disabled");
  // The local loopback app sees the same projection (DeviceView shape, client paired via its own registry).
  const local = await (await createHostApp(services.store, { devices: services.peersHttp! }).request("http://127.0.0.1/v1/devices")).json() as { items: { id: string; paired: boolean; role?: string }[] };
  assert.deepEqual(local.items.map((v) => [v.id, v.paired, v.role]), [[deviceId, true, undefined]]);
  // One admitted request with an unfinished body keeps the writer held.
  const target = new URL(url);
  const socket = connect({ host: target.hostname, port: Number(target.port), cert: phone.certPem, key: phone.keyPem, ca: [appHost.certPem],
    minVersion: "TLSv1.3", checkServerIdentity: () => undefined });
  socket.on("error", () => {});
  t.after(() => { socket.destroy(); });
  await new Promise<void>((resolve) => socket.once("secureConnect", () => resolve()));
  socket.write(`POST /v1/bots HTTP/1.1\r\nHost: ${target.host}\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{`);
  const peers = services.peersHttp!;
  await new Promise((r) => setTimeout(r, 100));
  const first = services.shutdown({ graceMs: 200 });
  assert.throws(() => peers.list(), HostError, "admission stops synchronously, before any drain await");
  await assert.rejects(first, /cleanup is not confirmed/);
  assert.throws(() => services.appClientsAdmin, HostError);
  assert.throws(() => peers.list(), HostError, "retained projection is refused after admission stops");
  assert.throws(() => new HostStore({ dataDir }), (e: unknown) => e instanceof HostError && e.code === "host_locked", "writer retained");
  socket.destroy();
  await services.shutdown({ graceMs: 3_000 });
  const reopened = new HostStore({ dataDir });
  try { assert.equal(reopened.listBots().length, 1, "the unfinished request created nothing"); } finally { reopened.close(); }
  await assert.rejects(services.startAppClients(), HostError);
});
