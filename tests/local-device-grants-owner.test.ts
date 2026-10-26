import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevicePairingRegistry } from "@dexter/devices";
import { createHostApp } from "@dexter/hub/http";
import { HostServices } from "../packages/cli/src/host-services.js";
import { memoryTLS } from "./fixtures/relay-host-lab.js";

test("owner grants HTTP lists paired agent only, CAS conflicts, deny blocks pending/ready and preserves unknown", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dexter-owner-grants-"));
  const host = new HostServices({ dataDir: join(root, "host"), devices: { identity: memoryTLS() } });
  const registry = new DevicePairingRegistry(host.store);
  t.after(async () => { registry.close(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const bot = host.store.createBot({ name: "Synthetic", profileId: "lab", engine: "claude" });
  const thread = host.store.createThread(bot.id);
  const offer = registry.createOffer({ kind: "pair" });
  const claim = registry.claim({ offerId: offer.offerId, code: offer.code, clientFingerprint: "a".repeat(64), name: "Synthetic Mac", capabilities: ["mac.browser.read"] });
  const paired = registry.approveClaim(claim.claimId);
  const unpaired = host.store.registerDevice({ name: "Unpaired synthetic", platform: "macos", capabilities: ["mac.browser.read"] });
  const app = createHostApp(host.store, { deviceGrants: host.deviceGrantsHttp! });
  const call = async (method: string, body?: unknown, origin?: string) => {
    const res = await app.request(`http://127.0.0.1/v1/device-grants?botId=${bot.id}`, { method,
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: await res.json() as any };
  };
  const initial = await call("GET");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json, { botId: bot.id, items: [{ botId: bot.id, tool: "mac.browser.read", destination: paired.deviceId, grant: null }] });
  const input = { botId: bot.id, tool: "mac.browser.read", destination: paired.deviceId, policy: "ask", expiresAt: null, expectedRevision: null };
  assert.equal((await call("PUT", { ...input, destination: unpaired.id })).status, 403);
  assert.equal((await call("PUT", input, "https://foreign.example")).status, 403);
  assert.equal((await call("PUT", { ...input, extra: true })).status, 400);
  const first = await call("PUT", input);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { botId: bot.id, tool: input.tool, destination: input.destination, policy: "ask", expiresAt: null, revision: 1 });
  assert.equal((await call("PUT", input)).status, 409);
  const action = (key: string) => host.store.requestAction({ botId: bot.id, threadId: thread.id, tool: input.tool, destination: input.destination, arguments: {}, idempotencyKey: key });
  const awaiting = action("awaiting"); assert.equal(awaiting.state, "awaiting_approval");
  assert.equal((await call("PUT", { ...input, policy: "allow", expectedRevision: 1 })).json.revision, 2);
  assert.equal(host.store.getAction(awaiting.id).state, "blocked");
  const ready = action("ready"); assert.equal(ready.state, "ready");
  assert.equal((await call("PUT", { ...input, policy: "deny", expectedRevision: 2 })).json.revision, 3);
  assert.equal(host.store.getAction(ready.id).state, "blocked");
  assert.equal((await call("PUT", { ...input, policy: "allow", expectedRevision: 3 })).json.revision, 4);
  const unknown = action("unknown"); host.store.claimAction(unknown.id); host.store.markUnknown(unknown.id, "executor_error");
  assert.equal((await call("PUT", { ...input, policy: "deny", expectedRevision: 4 })).json.revision, 5);
  assert.equal(host.store.getAction(unknown.id).state, "unknown");
  assert.equal((await call("PUT", { ...input, policy: "allow", expectedRevision: 4 })).status, 409);
  assert.equal((await call("GET")).json.items[0].grant.policy, "deny");
  assert.equal((await createHostApp(host.store).request(`http://127.0.0.1/v1/device-grants?botId=${bot.id}`)).status, 503);
  const held = host.deviceGrantsHttp!;
  await host.shutdown();
  assert.throws(() => held.list(bot.id));
});
