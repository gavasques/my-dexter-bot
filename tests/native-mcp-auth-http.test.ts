import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHostApp, createAuthorizedHostRouter } from "@dexter/hub/http";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
import type { planHostStartup as PlanType } from "../packages/cli/src/host-startup.js";
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };
const { planHostStartup } = await import(pathToFileURL(resolve("packages/cli/dist/host-startup.js")).href) as { planHostStartup: typeof PlanType };

test("owner HTTP credentials: explicit unlock, useful MCP ask/allow/deny, lock, admission and remote separation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-auth-http-"));
  let reads = 0;
  const secret = "synthetic-credential-http-517";
  const host = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    nativeMcp: { runsOn: "owner_mac", credentials: { custody: { kind: "synthetic",
      read: async () => { reads++; return secret; } } } } });
  try {
    const app = createHostApp(host.store, { mcp: host.nativeMcpHttp! });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`http://127.0.0.1${path}`, { method,
        headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const json = await res.json() as Record<string, any>;
      assert.ok(!JSON.stringify(json).includes(secret));
      return { status: res.status, json };
    };
    const base = "/v1/mcp/servers/auth";
    assert.equal((await call("POST", "/v1/mcp/servers", { definition: {
      id: "auth", name: "Synthetic auth", auth: "broker", runsOn: "owner_mac",
      transport: { type: "stdio", command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/mcp-fake-stdio-server.js", import.meta.url))],
        env: { API_TOKEN: { kind: "secret", key: "env.api_token" } } },
      limits: { connectTimeoutMs: 5_000, callTimeoutMs: 3_000 },
    } })).status, 201);
    assert.equal((await call("GET", `${base}/credentials`)).json.credentials.state, "locked");
    assert.equal(reads, 0);
    assert.equal(existsSync(join(dir, "mcp-stdio")), false);
    assert.equal((await call("POST", `${base}/credentials/unlock`, { token: secret })).status, 400);
    assert.equal(reads, 0);
    assert.equal((await app.request(`http://127.0.0.1${base}/credentials/unlock`, { method: "POST",
      headers: { "content-type": "application/json", origin: "https://other.example" }, body: "{}" })).status, 403);
    assert.equal((await createAuthorizedHostRouter(host.store).request(`http://127.0.0.1${base}/credentials`)).status, 403);
    assert.equal((await call("POST", `${base}/credentials/unlock`, {})).json.credentials.state, "unlocked");
    assert.equal(reads, 1);
    assert.equal((await call("POST", `${base}/discover`, {})).json.server.status, "ready");
    const bot = host.store.createBot({ name: "Synthetic", profileId: "test", engine: "claude" });
    const tool = "mcp.auth.echo_text";
    assert.equal((await call("PUT", `${base}/bots/${bot.id}`, { toolIds: [tool], policy: "ask" })).status, 200);
    const connection = host.gateway!.registry.listConnections("test").find(c => c.toolkit === "mcp-auth")!;
    const thread = host.store.createThread(bot.id);
    const { turn } = host.store.createTurn(thread.id, { clientRequestId: "synthetic-1", content: "echo" });
    host.store.claimNextTurn(thread.id);
    const token = host.gateway!.issueCapability({ turnId: turn.id }).token;
    const input = { tool, connectionId: connection.id, callId: "allow", arguments: { text: "useful" } };
    const pending = await host.gateway!.call(token, input);
    assert.equal(pending.status, "awaiting_approval");
    host.store.decideAction(pending.actionId, { decision: "allow", requestHash: pending.requestHash });
    const done = await host.gateway!.call(token, input);
    assert.equal(done.status, "succeeded");
    assert.ok(JSON.stringify(done.result).includes("echo:useful"));
    assert.ok(!JSON.stringify(done.result).includes(secret));
    const deniedInput = { ...input, callId: "deny", arguments: { text: "must-not-run" } };
    const pendingDeny = await host.gateway!.call(token, deniedInput);
    assert.equal(pendingDeny.status, "awaiting_approval");
    host.store.decideAction(pendingDeny.actionId, { decision: "deny", requestHash: pendingDeny.requestHash });
    assert.equal((await host.gateway!.call(token, deniedInput)).status, "denied");
    const calls = readFileSync(join(dir, "mcp-stdio/auth/calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(calls.filter(c => c.call).length, 1);
    assert.equal((await call("POST", `${base}/credentials/lock`, {})).json.credentials.state, "locked");
    assert.equal((await call("GET", "/v1/mcp/servers")).json.servers[0].status, "needs_auth");
    assert.equal(reads, 1, "status never rereads custody");
    const held = host.nativeMcpHttp!.credentials!;
    await host.shutdown();
    assert.throws(() => held.credentialStatus("auth"), (e: unknown) => (e as { code?: string }).code === "conflict");
    const absent = join(dir, "never-created");
    assert.throws(() => planHostStartup({ route: "production", options: { dataDir: absent,
      enableEngines: true, enableMcp: true, nativeMcp: { runsOn: "owner_mac", onePassword: { command: "op", vault: "Synthetic" } } } }));
    assert.equal(existsSync(absent), false, "invalid public configuration refuses before store creation");
    planHostStartup({ route: "production", options: { dataDir: absent, enableEngines: true, enableMcp: true,
      nativeMcp: { runsOn: "owner_mac", onePassword: { command: "/not-an-executed-op", vault: "Synthetic" } } } });
    assert.equal(existsSync(absent), false, "valid preflight never launches op or opens a store");
  } finally { await host.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
