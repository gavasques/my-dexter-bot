// Authorized paired-client router without TLS: the authority binding is the only principal, every route has an
// exact scope, body routes re-check after the await, and the local development app keeps its loopback guard.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostError, HostStore, type ClientDeviceScope } from "@dexter/hub";
import { createAuthorizedHostRouter, createHostApp, type HostRequestAuthority } from "@dexter/hub/http";

function lab(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-http-authority-"));
  const store = new HostStore({ dataDir: dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
function authority(store: HostStore, scopes: ClientDeviceScope[], current: () => boolean = () => true): HostRequestAuthority & { selfRevoked: string[]; checks: number } {
  const a = {
    principal: "paired-client" as const, installationId: store.hostId, ownerId: store.ownerId, deviceId: "dev_client", role: "client-ios" as const,
    scopes, pinGeneration: 1, bindingRevision: 1, selfRevoked: [] as string[], checks: 0,
    assertCurrent() { a.checks++; if (!current()) throw new HostError("forbidden", "Client binding is no longer current."); },
    noteSelfRevoke(id: string) { a.selfRevoked.push(id); },
  };
  return a;
}
const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ALL: ClientDeviceScope[] = ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read"];

test("no or foreign authority binding is refused on every route; headers/body never authenticate", async (t) => {
  const store = lab(t);
  const router = createAuthorizedHostRouter(store);
  const forged = { "x-owner-id": store.ownerId, "x-device-id": "dev_x", authorization: "Bearer x", "x-forwarded-for": "127.0.0.1", host: "127.0.0.1" };
  for (const path of ["/health", "/v1/bots", "/v1/contracts", "/v1/events"]) {
    assert.equal((await router.fetch(new Request(`https://app-client.invalid${path}`, { headers: forged }), {} as never)).status, 403, path);
  }
  const foreign = { ...authority(store, ALL), ownerId: "own_other" };
  assert.equal((await router.fetch(new Request("https://app-client.invalid/v1/bots"), { authority: foreign })).status, 403);
  const created = await router.fetch(new Request("https://app-client.invalid/v1/bots", json("POST", { name: "x", profileId: "p", engine: "codex", ownerId: "own_other" })), { authority: authority(store, ALL) });
  assert.equal(created.status, 400, "owner never comes from the body");
  assert.equal(store.listBots().length, 0);
});

test("every route checks its exact scope; empty scopes only reach health/contracts; local-only routes are 403", async (t) => {
  const store = lab(t);
  const router = createAuthorizedHostRouter(store);
  const bot = store.createBot({ name: "B", profileId: "p", engine: "codex" });
  const thread = store.createThread(bot.id);
  const none = authority(store, []);
  assert.equal((await router.fetch(new Request("https://app-client.invalid/health"), { authority: none })).status, 200);
  assert.equal((await router.fetch(new Request("https://app-client.invalid/v1/contracts"), { authority: none })).status, 200);
  const cases: [string, string, ClientDeviceScope, unknown?][] = [
    ["GET", "/v1/bots", "chat.read"], ["POST", "/v1/bots", "chat.write", { name: "x", profileId: "p", engine: "codex" }],
    ["GET", `/v1/bots/${bot.id}`, "chat.read"], ["POST", `/v1/bots/${bot.id}/threads`, "chat.write", {}],
    ["GET", `/v1/threads/${thread.id}`, "chat.read"], ["GET", `/v1/threads/${thread.id}/messages`, "chat.read"],
    ["POST", `/v1/threads/${thread.id}/messages`, "chat.write", { clientMessageId: "m1", content: "hi" }],
    ["GET", "/v1/events", "chat.read"], ["GET", `/v1/threads/${thread.id}/turns`, "chat.read"],
    ["GET", "/v1/actions", "approvals.read"], ["GET", "/v1/devices", "devices.read"], ["GET", `/v1/device-grants?botId=${bot.id}`, "grants.read"],
  ];
  for (const [method, path, scope, body] of cases) {
    const others = ALL.filter((s) => s !== scope);
    const init = body === undefined ? { method } : json(method, body);
    assert.equal((await router.fetch(new Request(`https://app-client.invalid${path}`, init), { authority: authority(store, others) })).status, 403, `${path} without ${scope}`);
    const allowed = (await router.fetch(new Request(`https://app-client.invalid${path}`, init), { authority: authority(store, [scope]) })).status;
    assert.notEqual(allowed, 403, `${path} with ${scope}`);
  }
  for (const [method, path] of [["POST", "/v1/actions"], ["POST", "/v1/devices"], ["POST", "/v1/devices/dev_x/heartbeat"], ["POST", "/v1/actions/act_x/dispatch"]]) {
    assert.equal((await router.fetch(new Request(`https://app-client.invalid${path}`, json(method!, {})), { authority: authority(store, ALL) })).status, 403, path);
  }
  // Without the trusted projection/grant ports the routes are unavailable, not silently local.
  assert.equal((await router.fetch(new Request("https://app-client.invalid/v1/devices"), { authority: authority(store, ALL) })).status, 503);
  assert.equal((await router.fetch(new Request("https://app-client.invalid/v1/bots?limit=101"), { authority: authority(store, ALL) })).status, 400);
});

test("a binding lost while reading JSON prevents the canonical write", async (t) => {
  const store = lab(t);
  const router = createAuthorizedHostRouter(store);
  let checks = 0;
  const flaky = authority(store, ALL, () => ++checks < 2);
  const response = await router.fetch(new Request("https://app-client.invalid/v1/bots", json("POST", { name: "x", profileId: "p", engine: "codex" })), { authority: flaky });
  assert.equal(response.status, 403);
  assert.equal(checks, 2, "checked at entry and immediately after the body await");
  assert.equal(store.listBots().length, 0);
});

test("the local development app keeps its loopback, origin and JSON guards", async (t) => {
  const store = lab(t);
  const app = createHostApp(store);
  assert.equal((await app.request("http://example.com/health")).status, 403);
  assert.equal((await app.request("http://127.0.0.1/health", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await app.request("http://127.0.0.1/v1/bots", json("POST", {}, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await app.request("http://127.0.0.1/v1/bots", { method: "POST", body: "{}" })).status, 415);
  const health = await (await app.request("http://127.0.0.1/health")).json() as { mode: string; remotePairing: string };
  assert.deepEqual([health.mode, health.remotePairing], ["local-development", "not_implemented"]);
  assert.equal((await app.request("http://127.0.0.1/v1/device-grants?botId=x")).status, 404, "remote-only routes do not exist locally");
});
