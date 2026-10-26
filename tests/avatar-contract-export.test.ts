import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { z } from "zod";
import {
  BotAvatarAppearanceSchema, BotAvatarAppearancesConfigurationSchema,
  ContractSchemas, PROTOCOL_VERSION, botAvatarAppearanceJSON,
  botAvatarAppearancesConfigurationJSON, exportContracts,
} from "@dexter/contracts";
import { HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";

const appearance = {
  version: 1, body: "cloud", eyes: "oval", colorHex: "#a45bcc", finish: "glass", motion: "subtle",
} as const;

test("avatar normalization preserves canonical color and rejects untrusted recipes", () => {
  const canonical = { ...appearance, colorHex: "#A45BCC" };
  for (const colorHex of ["#a45bcc", "#A45BCC", "#a45BcC"]) {
    const parsed = BotAvatarAppearanceSchema.parse({ ...appearance, colorHex });
    assert.deepEqual(parsed, canonical);
    assert.equal(botAvatarAppearanceJSON(parsed), JSON.stringify(canonical));
    assert.deepEqual(BotAvatarAppearanceSchema.parse(parsed), canonical);
  }
  const config = BotAvatarAppearancesConfigurationSchema.parse({ version: 1, bots: { bot_synthetic: appearance } });
  assert.equal(botAvatarAppearancesConfigurationJSON(config), JSON.stringify({ version: 1, bots: { bot_synthetic: canonical } }));

  for (const colorHex of [
    "#ABC", "#A45BCC00", "A45BCC", "#GGGGGG", " #A45BCC", "#A45BCC ", "#A45BCC\nextra",
    "#A45BCC;url(https://untrusted.invalid)", "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>", 123456, null, { hex: "#A45BCC" },
  ]) {
    assert.equal(BotAvatarAppearanceSchema.safeParse({ ...appearance, colorHex }).success, false);
  }
  assert.equal(BotAvatarAppearanceSchema.safeParse({ ...appearance, imageUrl: "https://untrusted.invalid/avatar.svg" }).success, false);
  assert.equal(BotAvatarAppearanceSchema.safeParse({ ...appearance, version: 2 }).success, false);
});

test("all public contracts export without weakening the closed avatar schema", () => {
  const exported = exportContracts();
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(ContractSchemas).sort());
  const avatar = z.toJSONSchema(BotAvatarAppearanceSchema);
  assert.equal(avatar.type, "object");
  assert.equal(avatar.additionalProperties, false);
  assert.deepEqual(avatar.properties?.colorHex, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" });
  for (const name of ["bot", "patchBot"] as const) {
    assert.equal(JSON.stringify(exported[name]).includes('"pattern":"^#[0-9a-fA-F]{6}$"'), true);
  }
});

test("GET /v1/contracts returns the complete public catalog over real loopback HTTP", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-avatar-contract-export-"));
  const store = new HostStore({ dataDir: dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = createHostApp(store);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) { resolve(); return; }
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/contracts`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const payload = await response.json() as { protocolVersion: string; schemas: Record<string, unknown> };
  assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(payload.schemas, exportContracts());
});
