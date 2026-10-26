import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceViewSchema, RenameDeviceSchema, EventRecordSchema, exportContracts } from "@dexter/contracts";
import { HostStore, HostError } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
test("device view/rename/event contracts are closed and project no pairing credentials", () => {
  assert.deepEqual(RenameDeviceSchema.parse({ name: "  Mac  " }), { name: "Mac" });
  for (const value of [{ name: "" }, { name: "x", ownerId: "other" }, { name: "x", capabilities: [] }, { name: "x", code: "never" }]) assert.equal(RenameDeviceSchema.safeParse(value).success, false);
  const view = { id: "dev", ownerId: "owner", name: "Mac", platform: "macos", capabilities: [], lastSeenAt: 1, revokedAt: null, presence: "stale", paired: false };
  assert.equal(DeviceViewSchema.safeParse(view).success, true);
  for (const change of [{ presence: "pending" }, { hostFingerprint: "never" }, { code: "never" }]) assert.equal(DeviceViewSchema.safeParse({ ...view, ...change }).success, false);
  assert.equal(EventRecordSchema.safeParse({ cursor: 1, id: "event", kind: "device.renamed", botId: null, threadId: null, entityId: "dev", createdAt: 1 }).success, true);
  assert.ok(exportContracts().deviceView); assert.ok(exportContracts().renameDevice);
});
test("rename is owner-fenced, persists only metadata, and emits one durable event", () => {
  const dir = mkdtempSync(join(tmpdir(), "dx-device-rename-")); let store = new HostStore({ dataDir: dir });
  try {
    const device = store.registerDevice({ name: "Before", platform: "macos", capabilities: ["mac.file.read"] });
    const bot = store.createBot({ name: "Bot", profileId: "work", engine: "claude" });
    const grant = store.setGrant({ botId: bot.id, tool: "mac.file.read", destination: device.id, policy: "allow" });
    assert.deepEqual(store.renameDevice(device.id, { name: "  After  " }), { ...device, name: "After" });
    store.renameDevice(device.id, { name: "After" });
    assert.equal(store.listEvents().filter(event => event.kind === "device.renamed").length, 1);
    assert.deepEqual(store.getGrant(bot.id, "mac.file.read", device.id), grant);
    assert.throws(() => store.renameDevice("foreign", { name: "Wrong" }), (error: unknown) => error instanceof HostError && error.code === "not_found");
    assert.throws(() => store.renameDevice(device.id, { name: "Wrong", capabilities: [] }));
    store.close(); store = new HostStore({ dataDir: dir }); assert.equal(store.getDevice(device.id).name, "After");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("loopback legacy enrollment remains compatible; rename/list/item/revoke use explicit device views", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dx-device-http-")), store = new HostStore({ dataDir: dir }), app = createHostApp(store);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post("/v1/devices", { name: "Before", platform: "macos", capabilities: ["mac.file.read"] }); assert.equal(created.status, 201);
    const device = await created.json() as { id: string };
    assert.equal((await post(`/v1/devices/${device.id}/heartbeat`, {})).status, 200);
    const changed = await app.request(`/v1/devices/${device.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "After" }) });
    assert.equal(changed.status, 200); const dto = DeviceViewSchema.parse(await changed.json()); assert.equal(dto.name, "After"); assert.equal(dto.paired, false);
    assert.equal((await app.request(`/v1/devices/${device.id}`)).status, 200);
    const list = await (await app.request("/v1/devices")).json() as { items: unknown[] }; assert.equal(list.items.length, 1); DeviceViewSchema.parse(list.items[0]);
    assert.equal((await post(`/v1/devices/${device.id}/revoke`, {})).status, 200); assert.equal(store.devicePresence(device.id), "revoked");
    assert.equal((await post("/v1/actions/missing/dispatch", { destination: device.id })).status, 400);
    assert.equal((await post("/v1/actions/missing/dispatch", {})).status, 503);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
