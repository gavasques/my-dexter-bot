import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeAppCustodian, oauthServers, until } from "./fixtures/oauth-custody-lab.js";

// Real `dexter serve` child process. The test plays the Apple app: private stdin FIFO + stdout pipe, answering custody
// requests like the Swift responder. Random loopback ports (never 4317/4318), synthetic OAuth/MCP servers, system-only
// PATH /usr/bin:/bin (no engine CLI there: no inference), private HOME. Only processes started here are stopped.
const CLI = resolve("packages/cli/dist/index.js");

interface Child { proc: ChildProcessWithoutNullStreams; url: string; hostId: string; requests: string[]; fifo: number; exited: Promise<number | null> }
async function start(t: TestContext, root: string, custodian: FakeAppCustodian, generation: number, reviewedIssuer:string): Promise<Child> {
  const fifoPath = join(root, `stdin-${generation}.fifo`);
  assert.equal(spawnSync("/usr/bin/mkfifo", ["-m", "600", fifoPath]).status, 0);
  const readEnd = openSync(fifoPath, "r+");
  const proc = spawn(process.execPath, [CLI, "serve", "--data-dir", join(root, "host"), "--port", "0", "--enable-engines", "--enable-mcp", "--browser-use-private-input", "--mcp-private-origin", reviewedIssuer], {
    stdio: [readEnd, "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp") + "/" },
  }) as unknown as ChildProcessWithoutNullStreams;
  closeSync(readEnd);
  const fifo = openSync(fifoPath, "w");
  const exited = new Promise<number | null>(r => proc.once("exit", code => r(code)));
  t.after(async () => { if (proc.exitCode === null && !proc.killed) { proc.kill("SIGTERM"); await exited; } try { closeSync(fifo); } catch { /* closed */ } });
  proc.stderr.resume();
  const requests: string[] = [];
  let buffer = "", ready: Record<string, unknown> | null = null;
  const readyPromise = new Promise<Record<string, unknown>>((resolveReady, reject) => {
    proc.once("exit", () => reject(new Error("host exited before ready")));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (!ready) {
        const end = buffer.indexOf("\n}\n");
        if (end < 0) return;
        ready = JSON.parse(buffer.slice(0, end + 2)) as Record<string, unknown>;
        buffer = buffer.slice(end + 3);
        resolveReady(ready);
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const object = JSON.parse(line) as Record<string, unknown>;
        if (object.schema !== "dexter.mcp-oauth-custody-request/1") continue;
        requests.push(String(object.type));
        const answer = custodian.answer(object, String(ready!.hostId));
        if (answer) writeSync(fifo, JSON.stringify(answer) + "\n");
      }
    });
  });
  const r = await readyPromise;
  assert.equal(r.status, "ready"); assert.equal(r.mcpGateway, "enabled");
  // Like the Swift supervisor: the host stays silent until the app, having parsed ready, opens custody.
  await new Promise(done => setTimeout(done, 150));
  assert.deepEqual(requests, [], "no custody request before the app opens it");
  writeSync(fifo, JSON.stringify({ schema: "dexter.mcp-oauth-custody-open/1", hostID: r.hostId }) + "\n");
  return { proc, url: String(r.url), hostId: String(r.hostId), requests, fifo, exited };
}
const api = async (child: Child, method: string, path: string, body?: unknown) => {
  const response = await fetch(child.url + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as any };
};

test("real CLI: app-custody handshake, authorize once, process restart auto-restores without a new authorization", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-oauth-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["home", "tmp"]) mkdirSync(join(root, dir));
  const oauth = await oauthServers(t), custodian = new FakeAppCustodian();
  const first = await start(t, root, custodian, 1, oauth.issuer());
  assert.ok(await until(() => first.requests.includes("mcp_oauth_custody.status")), "handshake after ready");
  let status = (await api(first, "GET", "/v1/connections/status")).json;
  for (let i = 0; i < 50 && status.nativeOAuthPersistence !== "persistent"; i++) { await new Promise(r => setTimeout(r, 20)); status = (await api(first, "GET", "/v1/connections/status")).json; }
  assert.equal(status.nativeOAuthPersistence, "persistent", "durable only after the app confirmed custody");
  assert.equal((await api(first, "POST", "/v1/mcp/servers", { definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: oauth.resource() } } })).status, 201);
  const started = await api(first, "POST", "/v1/mcp/servers/remote/oauth/start", {});
  assert.equal(started.status, 200);
  assert.equal(await oauth.browse(started.json.authorization.authorizationUrl), 200);
  let credential = (await api(first, "GET", "/v1/mcp/servers/remote/credentials")).json.credentials;
  for (let i = 0; i < 100 && credential.state !== "unlocked"; i++) { await new Promise(r => setTimeout(r, 20)); credential = (await api(first, "GET", "/v1/mcp/servers/remote/credentials")).json.credentials; }
  assert.equal(credential.state, "unlocked");
  assert.ok(await until(() => custodian.items.size === 1), "saved in app custody");
  const account = (await api(first, "GET", "/v1/connections/accounts")).json.items.find((a: { id: string }) => a.id === "mcp_remote");
  assert.equal(account.persistence, "app_keychain");
  assert.deepEqual(account.identity, { confirmation: "unconfirmed", value: null, kind: null, source: null, issuer: oauth.issuer(), checkedAt: null },
    "direct route: no account identity invented, only the validated issuer");
  const authorizations = oauth.counts.authorize;
  first.proc.kill("SIGTERM");
  assert.equal(await first.exited, 0);
  // Restart: the new process reads custody after its own ready line; no browser, no new authorization.
  const second = await start(t, root, custodian, 2, oauth.issuer());
  assert.equal(second.hostId, first.hostId);
  let restored = (await api(second, "GET", "/v1/mcp/servers/remote/credentials")).json.credentials;
  for (let i = 0; i < 100 && restored.state !== "unlocked"; i++) { await new Promise(r => setTimeout(r, 20)); restored = (await api(second, "GET", "/v1/mcp/servers/remote/credentials")).json.credentials; }
  assert.equal(restored.state, "unlocked");
  assert.equal(oauth.counts.authorize, authorizations, "no new authorization after restart");
  assert.deepEqual(second.requests.slice(0, 2), ["mcp_oauth_custody.status", "mcp_oauth_custody.load"]);
  for (const name of readdirSync(join(root, "host")).filter(f => f.includes("sqlite")))
    for (const token of oauth.live) assert.ok(!readFileSync(join(root, "host", name)).includes(token), `${name} holds no token`);
  second.proc.kill("SIGTERM");
  assert.equal(await second.exited, 0);
});
