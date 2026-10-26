import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, SyntheticCredentialBroker, GatewayError, checkManifest, checkNativeMcpSchema, checkNativeMcpArguments } from "@dexter/gateway";
import { validateNativeMcpArguments } from "@dexter/connectors";
const SECRET = "synthetic-catalog-canary-89bd127";
const host = "example.mcp.dexter.internal";
const nativeSchema = { type: "object", properties: { text: { anyOf: [{ type: "string" }, { type: "null" }] }, values: { type: "array", items: { type: "number" }, uniqueItems: true } }, required: ["values"], additionalProperties: true };
const manifest = { name: "mcp.example.read", toolkit: "mcp-example", upstreamSlug: "read", upstreamHost: host, version: "a".repeat(64), description: "Read original schema", effect: "read", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, nativeInputSchema: nativeSchema, destinationArgument: null, destinationOrigins: null };
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-native-schema-")), store = new HostStore({ dataDir: dir }), broker = new SyntheticCredentialBroker(); broker.put("credential", { headers: { authorization: `Bearer ${SECRET}` }, allowedHosts: [host] });
  let calls = 0;
  const gateway = new CapabilityGateway({ store, broker, adapter: { execute: async call => { calls++; return { echoed: call.arguments, isError: true, content: [{ type: "text", text: "semantic failure" }] }; } } });
  const bot = store.createBot({ name: "Synthetic", profileId: "profile", engine: "claude" }), thread = store.createThread(bot.id), turn = store.createTurn(thread.id, { clientRequestId: "native-schema", content: "synthetic" }).turn; store.claimNextTurn(thread.id);
  const connection = gateway.connectAccount({ profileId: "profile", toolkit: "mcp-example", label: "Account", upstreamAccountRef: "mcp:example", credentialRef: "credential", allowedHosts: [host] });
  t.after(() => { gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, gateway, bot, connection, turn, calls: () => calls };
}

test("native original schemas require trusted instance binding and a host validator before publication", t => {
  const f = fixture(t); assert.throws(() => f.gateway.registerTool(manifest), /validator unavailable/); f.gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments); const registered = f.gateway.registerTool(manifest);
  assert.deepEqual(registered.manifest.nativeInputSchema, nativeSchema); assert.equal(registered.manifest.nativeInputSchema?.additionalProperties, true);
  assert.doesNotThrow(() => f.gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments), "the same trusted validator binding is idempotent");
  assert.throws(() => f.gateway.setNativeMcpArgumentValidator(() => {}), /already bound/, "another validator cannot replace the admitted binding");
  assert.throws(() => checkManifest({ ...manifest, name: "managed.read", toolkit: "managed", upstreamHost: "managed.example.test" }));
  assert.throws(() => checkNativeMcpSchema({ ...nativeSchema, $ref: "https://never-fetch.example.test/schema" }));
});

test("native composite and extra fields remain exact and schema failures precede canonical action admission", async t => {
  const f = fixture(t); f.gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments); f.gateway.registerTool(manifest); f.store.setGrant({ botId: f.bot.id, tool: manifest.name, destination: f.connection.id, policy: "allow" }); const cap = f.gateway.issueCapability({ turnId: f.turn.id });
  const args = { text: null, values: [1, 2], customEvidence: { label: "original extra property" } };
  assert.deepEqual(f.gateway.listTools(cap.token)[0]?.inputSchema, nativeSchema);
  const succeeded = await f.gateway.call(cap.token, { tool: manifest.name, connectionId: f.connection.id, callId: "one", arguments: args }); assert.equal(succeeded.status, "succeeded"); assert.equal((succeeded.result as any).isError, true); assert.deepEqual((succeeded.result as any).echoed, args); assert.equal(f.calls(), 1);
  const before = f.store.listActions().length;
  for (const input of [{ values: [1, 1] }, { text: 42, values: [] }, { values: [1], customEvidence: { connectedAccountId: "other" } }]) await assert.rejects(f.gateway.call(cap.token, { tool: manifest.name, connectionId: f.connection.id, callId: "invalid", arguments: input }), (e: unknown) => e instanceof GatewayError);
  assert.equal(f.store.listActions().length, before); assert.equal(f.calls(), 1);
});

test("catalog definition contamination is refused whole before SQLite or model exposure, never redacted into another contract", t => {
  const f = fixture(t); f.gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);
  for (const poisoned of [{ ...manifest, description: SECRET }, { ...manifest, nativeInputSchema: { type: "object", properties: { text: { type: "string", enum: [SECRET] } } } }, { ...manifest, nativeInputSchema: { type: "object", properties: { text: { type: "string", default: SECRET } } } }]) assert.throws(() => f.gateway.registerTool(poisoned), /quarantined/);
  assert.equal(f.gateway.registry.listTools().length, 0);
  assert.throws(() => f.gateway.connectAccount({ profileId: "profile", toolkit: "mcp-example", label: SECRET, upstreamAccountRef: "mcp:example", credentialRef: "credential", allowedHosts: [host] }), /metadata refused/);
  const bytes = readdirSync(f.dir).filter(file => /sqlite/.test(file)).map(file => readFileSync(join(f.dir, file)).toString("latin1")).join(""); assert(!bytes.includes(SECRET));
});

test("dynamic native fields cannot select account, principal, tool, auth, code or unbounded destination", () => {
  for (const key of ["connectedAccountId", "userId", "owner_id", "toolName", "authorization", "code", "command", "url", "baseUrl"]) {
    assert.throws(() => checkNativeMcpArguments({ nested: { [key]: "untrusted" } })); assert.throws(() => checkNativeMcpSchema({ type: "object", properties: { nested: { type: "object", properties: { [key]: { type: "string" } } } } }));
  }
  assert.doesNotThrow(() => checkNativeMcpArguments({ values: [1, 2], customEvidence: { label: "plain business data" } }));
});
