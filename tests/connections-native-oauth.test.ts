import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { McpOAuthCustodyError, PrivateChannelMcpOAuthTokenStore, type McpOAuthCustodyRequest } from "@dexter/connectors";
import { AppPrivateMcpOAuthCustodyChannel } from "../packages/cli/src/mcp-oauth-private-custody.js";
import { bindBrowserUsePrivateInput } from "../packages/cli/src/browser-use-private-input.js";
import { FakeAppCustodian, nativeHost, oauthServers, until, wire } from "./fixtures/oauth-custody-lab.js";

// UX-P1-10 synthetic proofs: real NativeMcpRuntime/McpOAuthClient/custody store/private channel/private reader, a fake
// app custodian mirroring the Swift responder, loopback OAuth+MCP servers. No Keychain, account, login or real provider.
const PIN_A = "a".repeat(64), PIN_B = "b".repeat(64), RESOURCE = "https://mcp.example.test/mcp";
const tokens = (serverId = "notion", resource = RESOURCE) => ({ serverId, resource, resourceIndicator: resource, issuer: "https://auth.example.test",
  tokenEndpoint: "https://auth.example.test/token", clientId: "client-synthetic", clientSecret: null, accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: 1, scope: null });
const code = (name: string) => (e: unknown) => e instanceof McpOAuthCustodyError && e.code === name;

test("custody port: durable only after the custodian confirms; exact instance/resource keys; all-generation remove; bounded frames", async t => {
  const custodian = new FakeAppCustodian(), link = wire(custodian, "host_1");
  t.after(() => link.close());
  await link.opened;
  let pin = PIN_A, scope: { installationId: string; ownerId: string } | null = null;
  const store = new PrivateChannelMcpOAuthTokenStore({ scope: () => scope, instancePin: () => pin, channel: link.channel });
  assert.equal(store.durability(), "unverified");
  assert.equal(await store.verify(), "unavailable", "no store identity yet: never claimed durable");
  scope = { installationId: "host_1", ownerId: "owner_1" };
  assert.equal(await store.verify(), "durable");
  assert.equal(await store.load("notion", { resource: RESOURCE }), null);
  await store.save(tokens());
  assert.deepEqual(await store.load("notion", { resource: RESOURCE }), tokens());
  assert.equal(await store.load("notion", { resource: "https://other.example.test/mcp" }), null, "another endpoint never receives these tokens");
  pin = PIN_B;
  assert.equal(await store.load("notion", { resource: RESOURCE }), null, "a recreated instance never receives the previous tokens");
  await store.save({ ...tokens(), accessToken: "synthetic-access-2" });
  assert.equal(custodian.items.size, 1, "one item per instance: a new generation replaces the old one");
  await store.remove("notion");
  assert.equal(custodian.items.size, 0);
  await assert.rejects(store.load("notion"), code("refused"), "load always carries the pinned resource");
  await assert.rejects(store.save({ ...tokens(), accessToken: "x".repeat(8192), refreshToken: "y".repeat(8192) }), code("refused"), "over the private frame budget");
  await assert.rejects(store.load("Bad Id", { resource: RESOURCE }), code("refused"));
  assert.ok(link.lines.every(line => JSON.parse(line).hostID === "host_1"));
  // Another installation/owner scope never reads this host's item (the custodian binds installation to the ready host).
  scope = { installationId: "host_2", ownerId: "owner_1" };
  const other = new PrivateChannelMcpOAuthTokenStore({ scope: () => scope, instancePin: () => PIN_B, channel: link.channel, timeoutMs: 200 });
  assert.equal(await other.verify(), "unavailable", "a request for another host is ignored by the custodian");
  // Unavailable custodian: no durability claim, explicit failures, nothing fabricated.
  custodian.available = false;
  scope = { installationId: "host_1", ownerId: "owner_1" };
  const down = new PrivateChannelMcpOAuthTokenStore({ scope: () => scope, instancePin: () => PIN_A, channel: link.channel });
  assert.equal(await down.verify(), "unavailable");
  await assert.rejects(down.save(tokens()), code("unavailable"));
});

test("private pipe: silent until the app opens; answered frames do not spend the flood budget; a forged host frame cuts the channel", async t => {
  const channel = new AppPrivateMcpOAuthCustodyChannel(), stdin = new PassThrough();
  const request: McpOAuthCustodyRequest = { v: 1, type: "mcp_oauth_custody.status", requestId: "00000000-0000-4000-8000-000000000001", scope: { installationId: "h", ownerId: "o" } };
  await assert.rejects(channel.exchange(request, AbortSignal.timeout(100)), /unavailable/, "nothing is written before the host is armed");
  let locked = 0, opens = 0;
  const reader = bindBrowserUsePrivateInput(stdin, "h", { set() {}, async lock() { locked++; } }, () => {}, undefined, channel);
  t.after(() => reader.close());
  const written: string[] = [];
  channel.arm({ hostID: "h", write: line => written.push(line), onOpen: () => { opens++; } });
  // Armed after ready but silent: no request line can share a read with the ready object until the app opens.
  await assert.rejects(channel.exchange(request, AbortSignal.timeout(100)), /unavailable/);
  stdin.write(JSON.stringify({ schema: "dexter.mcp-oauth-custody-open/1", hostID: "h", extra: 1 }) + "\n");
  stdin.write(JSON.stringify({ schema: "dexter.mcp-oauth-custody-open/1", hostID: "h" }) + "\n");
  stdin.write(JSON.stringify({ schema: "dexter.mcp-oauth-custody-open/1", hostID: "h" }) + "\n");
  assert.ok(await until(() => channel.open));
  assert.equal(opens, 1, "exact shape only, opened once");
  assert.equal(written.length, 0);
  // 200 answered exchanges (more than the 128-frame budget of unsolicited input) keep the channel alive.
  for (let i = 0; i < 200; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const pending = channel.exchange({ ...request, requestId: id }, AbortSignal.timeout(2_000));
    stdin.write(JSON.stringify({ schema: "dexter.mcp-oauth-custody-result/1", hostID: "h", v: 1, type: "mcp_oauth_custody.result", requestId: id, status: "ok", custody: "data_protection_keychain" }) + "\n");
    assert.deepEqual(await pending, { v: 1, type: "mcp_oauth_custody.result", requestId: id, status: "ok", custody: "data_protection_keychain" });
  }
  assert.equal(written.length, 200); assert.equal(locked, 0);
  assert.ok(written.every(line => JSON.parse(line).schema === "dexter.mcp-oauth-custody-request/1"));
  stdin.write(JSON.stringify({ schema: "dexter.mcp-oauth-custody-result/1", hostID: "another", v: 1, requestId: "00000000-0000-4000-8000-000000000999", status: "ok" }) + "\n");
  assert.ok(await until(() => locked === 1), "a frame for another host disables the private input and locks custody");
});

test("restart: authorize once, host restart restores from app custody without a new authorization; restore grants nothing", async t => {
  const oauth = await oauthServers(t), custodian = new FakeAppCustodian(), h = nativeHost(t, custodian, {privateOrigins:[oauth.issuer()]});
  await h.open();
  t.after(async () => { try { await h.close(); } catch { /* closed by the test */ } });
  const admin = () => h.runtime.admin;
  const bot = h.store.createBot({ name: "Ops", profileId: "work", engine: "claude" }), other = h.store.createBot({ name: "Other", profileId: "work", engine: "claude" });
  admin().addServer({ definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: oauth.resource() } } });
  assert.equal(await h.custody.verify(), "durable");
  assert.equal(h.runtime.oauthDurability, "durable");
  assert.equal(await oauth.browse((await admin().startOAuth("remote", {})).authorizationUrl), 200);
  assert.ok(await until(() => admin().credentialStatus("remote").state === "unlocked"));
  assert.ok(await until(() => custodian.items.size === 1), "tokens saved in app custody");
  assert.equal(h.runtime.oauthPersisted("remote"), true);
  await admin().discover("remote");
  admin().setBotSelection("remote", bot.id, { toolIds: ["mcp.remote.lookup"], policy: "ask" });
  const connection = h.gateway.registry.listConnections("work").find(c => c.toolkit === "mcp-remote")!;
  assert.equal((await h.approvedCall(bot.id, "mcp.remote.lookup", connection.id, { q: "a" })).status, "succeeded");
  const authorizations = oauth.counts.authorize;
  // Restart: the in-memory tokens are gone; durable restore reads custody once, with no new authorization.
  await h.close();
  await h.open();
  assert.equal(admin().credentialStatus("remote").state, "unauthorized");
  assert.equal(await h.custody.verify(), "durable");
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 1, persisted: 0, needsReconnect: 0, unavailable: 0, skipped: 0 });
  assert.equal(admin().credentialStatus("remote").state, "unlocked");
  assert.equal(oauth.counts.authorize, authorizations, "no new authorization");
  assert.deepEqual(admin().botSelection("remote", bot.id).toolIds, ["mcp.remote.lookup"]);
  assert.deepEqual(h.tools(other.id), [], "restore never authorizes another bot");
  assert.equal((await h.approvedCall(bot.id, "mcp.remote.lookup", connection.id, { q: "b" })).status, "succeeded");
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 0, needsReconnect: 0, unavailable: 0, skipped: 1 }, "already held: no second custody read");
  // No token in host databases, files or owner-visible values.
  for (const name of readdirSync(h.dataDir).filter(f => f.includes("sqlite")))
    for (const token of oauth.live) assert.ok(!readFileSync(join(h.dataDir, name)).includes(token), `${name} holds no OAuth token`);
  for (const token of oauth.live) assert.ok(!JSON.stringify([admin().listServers(), admin().credentialStatus("remote")]).includes(token));
});

test("restore refreshes expired tokens on the same destination/client; invalid_grant ends as needs-reconnect with custody removed, no loop", async t => {
  const oauth = await oauthServers(t), custodian = new FakeAppCustodian();
  let clock = Date.now();
  const h = nativeHost(t, custodian, { now: () => clock, privateOrigins:[oauth.issuer()] });
  await h.open();
  t.after(async () => { try { await h.close(); } catch { /* closed by the test */ } });
  const admin = () => h.runtime.admin;
  admin().addServer({ definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: oauth.resource() } } });
  await h.custody.verify();
  await oauth.browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.ok(await until(() => custodian.items.size === 1));
  const first = JSON.parse(custodian.items.values().next().value!) as { instancePin: string; resource: string; tokens: Record<string, unknown> };
  await h.close();
  clock += 2 * 3600_000;
  await h.open(); await h.custody.verify();
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 1, persisted: 0, needsReconnect: 0, unavailable: 0, skipped: 0 });
  assert.equal(oauth.counts.refresh, 1);
  const second = JSON.parse(custodian.items.values().next().value!) as typeof first;
  assert.notEqual(second.tokens.accessToken, first.tokens.accessToken);
  for (const field of ["serverId", "resource", "resourceIndicator", "issuer", "tokenEndpoint", "clientId"])
    assert.equal(second.tokens[field], first.tokens[field], `refresh never changes ${field}`);
  assert.equal(second.instancePin, first.instancePin); assert.equal(second.resource, first.resource);
  // Grant revoked at the issuer: one refresh attempt at restore, tokens forgotten everywhere, owner must reconnect.
  oauth.mode.revoked = true;
  await h.close();
  clock += 2 * 3600_000;
  await h.open(); await h.custody.verify();
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 0, needsReconnect: 1, unavailable: 0, skipped: 0 });
  assert.equal(admin().credentialStatus("remote").state, "unauthorized");
  assert.equal(admin().credentialStatus("remote").lastError, "needs_auth");
  assert.ok(await until(() => custodian.items.size === 0), "invalid grant removed from custody");
  const refreshes = oauth.counts.refresh;
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 0, needsReconnect: 1, unavailable: 0, skipped: 0 });
  assert.equal(oauth.counts.refresh, refreshes, "no refresh loop without tokens");
});

test("custody unavailable keeps the session honest; cancelled OAuth stores nothing; removal deletes custody; another host never reads it", async t => {
  const oauth = await oauthServers(t), custodian = new FakeAppCustodian(), h = nativeHost(t, custodian, {privateOrigins:[oauth.issuer()]});
  await h.open();
  t.after(async () => { try { await h.close(); } catch { /* closed by the test */ } });
  const admin = () => h.runtime.admin;
  admin().addServer({ definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: oauth.resource() } } });
  custodian.available = false;
  assert.equal(await h.custody.verify(), "unavailable");
  assert.equal(h.runtime.oauthDurability, "unavailable");
  await oauth.browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.ok(await until(() => admin().credentialStatus("remote").state === "unlocked"), "authorization still usable in memory");
  assert.equal(admin().credentialStatus("remote").lastError, "custody_unavailable");
  assert.equal(h.runtime.oauthPersisted("remote"), false, "reported as NOT persisted");
  assert.equal(custodian.items.size, 0);
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 0, needsReconnect: 0, unavailable: 0, skipped: 0 }, "no restore without durable custody");
  // Custody back later (e.g. the Mac unlocked): the owner's Restaurar re-confirms custody and saves the SAME authorization
  // once, without a new authorization (no handshake was repeated in between).
  custodian.available = true;
  const authorizations = oauth.counts.authorize;
  assert.equal(h.custody.durability(), "unavailable");
  assert.equal((await admin().unlockCredentials("remote")).state, "unlocked");
  assert.equal(h.custody.durability(), "durable");
  assert.equal(custodian.items.size, 1); assert.equal(h.runtime.oauthPersisted("remote"), true);
  assert.equal(admin().credentialStatus("remote").lastError, null); assert.equal(oauth.counts.authorize, authorizations);
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 0, needsReconnect: 0, unavailable: 0, skipped: 1 }, "saved once");
  await admin().disconnectCredentials("remote");
  assert.equal(custodian.items.size, 0);
  // Same through the start-of-host restore once custody is confirmed there.
  custodian.available = false;
  await oauth.browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.ok(await until(() => admin().credentialStatus("remote").lastError === "custody_unavailable"));
  custodian.available = true;
  assert.equal(await h.custody.verify(), "durable");
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 1, needsReconnect: 0, unavailable: 0, skipped: 0 });
  assert.equal(custodian.items.size, 1);
  await admin().disconnectCredentials("remote");
  assert.equal(custodian.items.size, 0);
  // Owner cancels in the browser: nothing saved anywhere.
  oauth.mode.deny = true;
  assert.equal(await oauth.browse((await admin().startOAuth("remote", {})).authorizationUrl), 400);
  assert.ok(await until(() => admin().credentialStatus("remote").lastError === "oauth_denied"));
  assert.equal(custodian.items.size, 0);
  oauth.mode.deny = false;
  await oauth.browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.ok(await until(() => custodian.items.size === 1));
  // Disconnect deletes it from custody (every generation of this instance).
  assert.equal((await admin().disconnectCredentials("remote")).state, "unauthorized");
  assert.equal(custodian.items.size, 0);
  await oauth.browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.ok(await until(() => custodian.items.size === 1));
  const before = [...custodian.items.keys()];
  // Remove the instance: custody item deleted; a recreated instance with the same id never receives older tokens.
  await admin().removeServer("remote");
  assert.equal(custodian.items.size, 0);
  admin().addServer({ definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: oauth.resource() } } });
  custodian.items.set(before[0]!, JSON.stringify({ v: 1, serverId: "remote", instancePin: "c".repeat(64), resource: oauth.resource(), tokens: {} }));
  assert.deepEqual(await h.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 0, needsReconnect: 1, unavailable: 0, skipped: 0 }, "older generation is absent for the new instance");
  assert.equal(admin().credentialStatus("remote").state, "unauthorized");
  // Another host over the same custodian: its own scope only.
  const second = nativeHost(t, custodian, {privateOrigins:[oauth.issuer()]});
  await second.open();
  t.after(async () => { try { await second.close(); } catch { /* closed */ } });
  second.runtime.admin.addServer({ definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: oauth.resource() } } });
  await second.custody.verify();
  assert.deepEqual(await second.runtime.restoreOAuthCredentials(), { restored: 0, persisted: 0, needsReconnect: 1, unavailable: 0, skipped: 0 });
});
