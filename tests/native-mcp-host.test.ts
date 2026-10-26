import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAuthorizedHostRouter, createHostApp } from "@dexter/hub/http";
import { NATIVE_MCP_DATABASE_FILE } from "@dexter/connectors";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };
type HostServices = HostServicesType;

// Synthetic values only. Real HostServices/HostStore/gateway/router; the upstream is the independent fake stdio server.
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fake-stdio-server.js", import.meta.url));
const CANARY = ["canary-native-env-7q1", "ghp_canaryNATIVE0123456789abcdefABCDEF"] as const;
const ECHO = "mcp.fake.echo_text";
const READ = "mcp.fake.claims_read_only";

const definition = (over: Record<string, unknown> = {}) => ({
  id: "fake", name: "Fake", runsOn: "owner_mac", auth: "none",
  transport: { type: "stdio", command: process.execPath, args: [FIXTURE] },
  readOnlyTools: [], limits: { callTimeoutMs: 3_000, connectTimeoutMs: 10_000 }, ...over,
});

function open(dataDir: string): HostServices {
  return new HostServices({ dataDir, enableEngines: true, engineCommands:{codex:"/usr/bin/false"}, enableMcp: true, nativeMcp: { runsOn: "owner_mac" } });
}

test("native MCP host: import noexec, persisted servers, explicit discovery, ask grants per bot, approval, restart without spawn, re-review, delete, shutdown", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-native-mcp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "host");
  const stdioHome = join(dataDir, "mcp-stdio", "fake");
  const calls = (): { call?: string; list?: boolean }[] => existsSync(join(stdioHome, "calls.log"))
    ? readFileSync(join(stdioHome, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

  let services = open(dataDir);
  let closed = false;
  t.after(async () => { if (!closed) await services.shutdown(); });
  const store = () => services.store;
  const app = () => createHostApp(services.store, { ...(services.runtime ? { runtime: services.runtime } : {}), mcp: services.nativeMcpHttp! });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await app().request(`http://127.0.0.1${path}`, {
      method, headers: { host: "127.0.0.1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };

  const a = store().createBot({ name: "A", profileId: "work", engine: "claude" });
  const b = store().createBot({ name: "B", profileId: "work", engine: "codex" });

  // Empty runtime: nothing persisted, nothing started, listing does not create files.
  assert.deepEqual((await call("GET", "/v1/mcp/servers")).json, { servers: [] });
  assert.equal(existsSync(join(dataDir, NATIVE_MCP_DATABASE_FILE)), false);

  // Paired-client router never exposes these routes.
  const remote = await createAuthorizedHostRouter(store()).request("http://127.0.0.1/v1/mcp/servers");
  assert.equal(remote.status, 403);
  // Loopback guards apply.
  const foreign = await app().request("http://127.0.0.1/v1/mcp/servers", { headers: { host: "evil.example" } });
  assert.equal(foreign.status, 403);

  // Import preview: no execution, no values in the answer.
  const preview = await call("POST", "/v1/mcp/import-preview", { format: "claude_json", content: JSON.stringify({ mcpServers: {
    gh: { command: "npx", args: ["-y", "@example/gh"], env: { GITHUB_TOKEN: CANARY[1], PLAIN: CANARY[0] } },
  } }) });
  assert.equal(preview.status, 200);
  for (const c of CANARY) assert.ok(!JSON.stringify(preview.json).includes(c));
  assert.equal(existsSync(join(dataDir, "mcp-stdio")), false, "preview starts nothing");
  const bad = await call("POST", "/v1/mcp/import-preview", { format: "claude_json", content: `{"mcpServers":{"a":{"env":{"K":"${CANARY[0]}"}}` });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.json).includes(CANARY[0]));

  // Literal secrets/credential-like args are not stored; broker/OAuth servers are stored but need auth and never start.
  const literal = await call("POST", "/v1/mcp/servers", { definition: definition({ id: "lit", transport: { type: "stdio", command: "/bin/echo", env: { K: { kind: "literal", value: CANARY[0] } } } }) });
  assert.equal(literal.status, 400);
  assert.ok(!JSON.stringify(literal.json).includes(CANARY[0]));
  const oauth = await call("POST", "/v1/mcp/servers", { definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: "http://127.0.0.1:9/mcp" } } });
  assert.equal(oauth.status, 201);
  assert.deepEqual(oauth.json.server, { id: "remote", name: "Remote", transport: "streamable_http", runsOn: "any", auth: "oauth", status: "needs_auth", destination: "http://127.0.0.1:9/mcp",
    diagnostic: { stage: "authentication", code: "needs_auth", recovery: "owner_authenticate_privately" } });
  assert.deepEqual((await call("POST", "/v1/mcp/servers/remote/discover", {})).json, { server: oauth.json.server, tools: [] });

  // Stored definition: exclusive id, no spawn by listing/reading.
  const added = await call("POST", "/v1/mcp/servers", { definition: definition() });
  assert.equal(added.status, 201);
  assert.deepEqual(added.json.server, { id: "fake", name: "Fake", transport: "stdio", runsOn: "owner_mac", auth: "none", status: "configured", destination: process.execPath });
  assert.equal((await call("POST", "/v1/mcp/servers", { definition: definition() })).status, 409);
  assert.deepEqual((await call("GET", "/v1/mcp/servers/fake/tools")).json, { tools: [] });
  assert.equal((await call("PUT", `/v1/mcp/servers/fake/bots/${a.id}`, { toolIds: [ECHO], policy: "ask" })).status, 409, "no catalog yet");
  assert.equal(existsSync(stdioHome), false, "listing/reading never starts the server");
  assert.equal((await call("POST", "/v1/mcp/servers/fake/discover", { extra: true })).status, 400);

  // Explicit discovery: lists, plans, calls nothing.
  const found = await call("POST", "/v1/mcp/servers/fake/discover", {});
  assert.equal(found.status, 200);
  assert.equal((found.json.server as { status: string }).status, "ready");
  const states = Object.fromEntries((found.json.tools as { id: string; state: string; effect: string }[]).map((x) => [x.id, [x.state, x.effect]]));
  assert.deepEqual(states[ECHO], ["publishable", "write"]);
  assert.deepEqual(states[READ], ["publishable", "write"], "upstream readOnlyHint never relaxes effect");
  assert.equal(states["mcp.fake.run_shell"]![0], "refused_by_policy");
  assert.equal(states["mcp.fake.nested"]![0], "publishable", "supported original nested schema is retained by native validation");
  assert.deepEqual(calls().filter((c) => c.call), []);
  assert.equal(calls().filter((c) => c.list).length, 1);
  assert.deepEqual((await call("GET", "/v1/mcp/servers/fake/tools")).json.tools, found.json.tools);

  // Selections: refused/unknown tools rejected; ask grants per bot on the profile's connection.
  assert.equal((await call("PUT", `/v1/mcp/servers/fake/bots/${a.id}`, { toolIds: ["mcp.fake.run_shell"], policy: "ask" })).status, 400);
  assert.equal((await call("PUT", `/v1/mcp/servers/fake/bots/${a.id}`, { toolIds: [ECHO], policy: "allow" })).status, 400);
  assert.equal((await call("PUT", "/v1/mcp/servers/fake/bots/bot_missing", { toolIds: [ECHO], policy: "ask" })).status, 404);
  const selA = await call("PUT", `/v1/mcp/servers/fake/bots/${a.id}`, { toolIds: [READ, ECHO], policy: "ask" });
  assert.deepEqual(selA.json, { botId: a.id, toolIds: [READ, ECHO].sort(), policy: "ask" });
  assert.deepEqual((await call("PUT", `/v1/mcp/servers/fake/bots/${b.id}`, { toolIds: [ECHO], policy: "ask" })).json.toolIds, [ECHO]);
  assert.deepEqual((await call("GET", `/v1/mcp/servers/fake/bots/${a.id}`)).json, selA.json);

  const gateway = services.gateway!;
  const [connection] = gateway.registry.listConnections("work").filter((c) => c.toolkit === "mcp-fake");
  assert.ok(connection, "one connection for the profile");
  let n = 0;
  const capability = (botId: string): string => {
    const thread = store().createThread(botId);
    const { turn } = store().createTurn(thread.id, { clientRequestId: `req-${++n}`, content: "go" });
    store().claimNextTurn(thread.id);
    return gateway.issueCapability({ turnId: turn.id }).token;
  };
  const tokenA = capability(a.id);
  assert.deepEqual(gateway.listTools(tokenA).map((v) => [v.name, v.requiresApproval]).sort(), [[READ, true], [ECHO, true]]);
  const input = { tool: ECHO, connectionId: connection.id, callId: "c1", arguments: { text: "hi" } };
  const asked = await gateway.call(tokenA, input);
  assert.equal(asked.status, "awaiting_approval");
  assert.deepEqual(calls().filter((c) => c.call), [], "ask waits; nothing called");
  store().decideAction(asked.actionId, { decision: "allow", requestHash: asked.requestHash });
  const done = await gateway.call(tokenA, input);
  assert.equal(done.status, "succeeded");
  assert.equal((done.result as { content: { text: string }[] }).content[0]!.text, "echo:hi");
  assert.deepEqual(calls().filter((c) => c.call).map((c) => c.call), ["echo_text"]);
  const replay = await gateway.call(tokenA, input);
  assert.equal(replay.status, "succeeded");
  assert.equal(calls().filter((c) => c.call).length, 1, "a replay never re-executes");

  // Removing a tool from the selection denies it for that bot only.
  await call("PUT", `/v1/mcp/servers/fake/bots/${a.id}`, { toolIds: [READ], policy: "ask" });
  assert.equal(store().getGrant(a.id, ECHO, connection.id)?.policy, "deny");
  assert.equal(store().getGrant(b.id, ECHO, connection.id)?.policy, "ask");
  assert.deepEqual(gateway.listTools(capability(a.id)).map((v) => v.name), [READ]);

  // Restart: records only, no spawn; manifests stay pinned; denies persist.
  const listsBefore = calls().filter((c) => c.list).length;
  await services.shutdown();
  services = open(dataDir);
  assert.deepEqual(((await call("GET", "/v1/mcp/servers")).json.servers as { id: string; status: string }[]).map((s) => [s.id, s.status]), [["fake", "ready"], ["remote", "needs_auth"]]);
  assert.deepEqual((await call("GET", `/v1/mcp/servers/fake/bots/${b.id}`)).json.toolIds, [ECHO]);
  assert.equal(((await call("GET", "/v1/mcp/servers/fake/tools")).json.tools as unknown[]).length, (found.json.tools as unknown[]).length);
  assert.equal(calls().filter((c) => c.list).length, listsBefore, "restore starts nothing");
  assert.equal(services.gateway!.registry.getTool(ECHO)?.status, "active");
  assert.equal(services.store.getGrant(a.id, ECHO, connection.id)?.policy, "deny");

  // Upstream changed the published tool: discovery never re-approves it silently.
  writeFileSync(join(stdioHome, "rugpull"), "1");
  const rediscovered = await call("POST", "/v1/mcp/servers/fake/discover", {});
  assert.equal((rediscovered.json.server as { status: string }).status, "ready");
  assert.deepEqual((await call("GET", `/v1/mcp/servers/fake/bots/${b.id}`)).json.toolIds, []);
  assert.equal(services.store.getGrant(b.id, ECHO, connection.id)?.policy, "deny");
  assert.equal(services.gateway!.registry.getTool(ECHO)?.status, "retired");
  assert.deepEqual((await call("GET", `/v1/mcp/servers/fake/bots/${a.id}`)).json.toolIds, [READ], "unchanged tools stay selected");

  // Delete: connection revoked, grants denied, manifests retired, records and private dir removed.
  const removed = await call("DELETE", "/v1/mcp/servers/fake");
  assert.deepEqual(removed.json, { removed: true });
  assert.equal(services.gateway!.registry.getConnection(connection.id)?.status, "revoked");
  assert.equal(services.store.getGrant(a.id, READ, connection.id)?.policy, "deny");
  assert.equal(services.gateway!.registry.getTool(READ)?.status, "retired");
  assert.equal((await call("GET", "/v1/mcp/servers/fake/tools")).status, 404);
  assert.deepEqual(((await call("GET", "/v1/mcp/servers")).json.servers as { id: string }[]).map((s) => s.id), ["remote"]);
  assert.equal(existsSync(stdioHome), false);

  // Shutdown: retained ports refuse without effects.
  const port = services.nativeMcpHttp!;
  const shutting = services.shutdown();
  assert.throws(() => port.addServer({ definition: definition({ id: "late" }) }), (e: unknown) => (e as { code?: string }).code === "conflict");
  await shutting;
  closed = true;
  services = open(dataDir);
  assert.deepEqual(((await call("GET", "/v1/mcp/servers")).json.servers as { id: string }[]).map((s) => s.id), ["remote"], "nothing admitted during shutdown");
  await services.shutdown();
});
