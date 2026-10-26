import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { CONNECTIONS_CAPABILITY_ACK_SCHEMA, CONNECTIONS_CAPABILITY_FRAME_SCHEMA } from "@dexter/contracts";

// The REAL `dexter serve` executable launched like the Apple app does: private stdin FIFO + stdout pipe, MCP engines on.
// The owner saves the configuration over loopback; only a restart composes the service (planHostStartup →
// providers.connections); the capability then crosses ONLY the FIFO and is acknowledged on stdout. A lost ACK is settled by
// GET. The origin is a reserved name (`.test`): no DNS, no network, no account. Random ports, own processes only.
const CLI = resolve("packages/cli/dist/index.js");
const ORIGIN = "https://connections.dexter.test";
const CAPABILITY = "dxcap_" + "Q".repeat(40) + "_synthetic";

interface Child { proc: ChildProcessWithoutNullStreams; url: string; hostId: string; acks: Array<Record<string, unknown>>; fifo: number | null; stdout: string[]; stderr: string[]; exited: Promise<number | null> }
async function start(t: TestContext, root: string, n: number, privatePipe = true): Promise<Child> {
  let readEnd: number | "ignore" = "ignore", fifoPath = "";
  if (privatePipe) {
    fifoPath = join(root, `stdin-${n}.fifo`);
    assert.equal(spawnSync("/usr/bin/mkfifo", ["-m", "600", fifoPath]).status, 0);
    readEnd = openSync(fifoPath, "r+");
  }
  const args = [CLI, "serve", "--data-dir", join(root, "host"), "--port", "0", "--enable-engines", "--enable-mcp", ...(privatePipe ? ["--browser-use-private-input"] : [])];
  const proc = spawn(process.execPath, args, { stdio: [readEnd, "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp") + "/" } }) as unknown as ChildProcessWithoutNullStreams;
  if (typeof readEnd === "number") closeSync(readEnd);
  const fifo = privatePipe ? openSync(fifoPath, "w") : null;
  const exited = new Promise<number | null>(r => proc.once("exit", code => r(code)));
  t.after(async () => { if (proc.exitCode === null && !proc.killed) { proc.kill("SIGTERM"); await exited; } if (fifo !== null) { try { closeSync(fifo); } catch { /* closed */ } } });
  const acks: Array<Record<string, unknown>> = [], stdout: string[] = [], stderr: string[] = [];
  proc.stderr.setEncoding("utf8"); proc.stderr.on("data", (chunk: string) => stderr.push(chunk));
  let buffer = "", ready: Record<string, unknown> | null = null;
  const readyPromise = new Promise<Record<string, unknown>>((resolveReady, reject) => {
    proc.once("exit", () => reject(new Error("host exited before ready: " + stderr.join(""))));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout.push(chunk); buffer += chunk;
      if (!ready) {
        const end = buffer.indexOf("\n}\n");
        if (end < 0) return;
        ready = JSON.parse(buffer.slice(0, end + 2)) as Record<string, unknown>; buffer = buffer.slice(end + 3); resolveReady(ready);
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const object = JSON.parse(line) as Record<string, unknown>;
        if (object.schema === CONNECTIONS_CAPABILITY_ACK_SCHEMA) acks.push(object);
      }
    });
  });
  const r = await readyPromise;
  assert.equal(r.status, "ready"); assert.ok(!/:4317$|:4318$/.test(String(r.url)));
  return { proc, url: String(r.url), hostId: String(r.hostId), acks, fifo, stdout, stderr, exited };
}
const stop = async (child: Child): Promise<void> => { child.proc.kill("SIGTERM"); await child.exited; if (child.fifo !== null) closeSync(child.fifo); child.fifo = null; };
const api = async (child: Child, method: string, path: string, body?: unknown) => {
  const r = await fetch(child.url + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: await r.json() as any };
};
const frame = (child: Child, over: Record<string, unknown> = {}) => ({ schema: CONNECTIONS_CAPABILITY_FRAME_SCHEMA, requestId: randomUUID(), hostID: child.hostId,
  operation: "set", origin: ORIGIN, generation: 1, capability: CAPABILITY, ...over });
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !done(value); i++) { await new Promise(r => setTimeout(r, 20)); value = await read(); }
  return value;
}

test("real CLI: owner saves metadata, restart composes providers.connections, capability only over the FIFO, lost ACK settled by GET", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-conn-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ["home", "tmp"]) mkdirSync(join(root, d));
  const first = await start(t, root, 1);
  let status = (await api(first, "GET", "/v1/connections/platform-configuration")).json;
  assert.deepEqual([status.custody.channel, status.runtime.state, status.runtime.reason], ["app_private_channel", "inactive", "disabled"]);
  const saved = await api(first, "PUT", "/v1/connections/platform-configuration",
    { expectedHostId: first.hostId, clientRequestId: "cli-save-1", expectedRevision: 0, origin: ORIGIN, enabled: true, renewCredential: false });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.receipt.configuration.generation, saved.json.receipt.restartRequired, saved.json.status.runtime.state], [1, true, "restart_required"]);
  // Before the restart no service exists: a capability frame is refused (nothing to hold it for).
  writeSync(first.fifo!, JSON.stringify(frame(first)) + "\n");
  assert.equal((await waitFor(async () => first.acks, a => a.length > 0))[0]!.status, "refused");
  await stop(first);

  const second = await start(t, root, 2);
  status = (await api(second, "GET", "/v1/connections/platform-configuration")).json;
  assert.deepEqual([status.runtime.state, status.runtime.origin, status.runtime.generation, status.custody.state], ["active", ORIGIN, 1, "absent"]);
  assert.equal((await api(second, "GET", "/v1/connections/status")).json.platform, "unavailable", "composed, capability absent: not available");
  const set = frame(second);
  writeSync(second.fifo!, JSON.stringify(set) + "\n");
  const acks = await waitFor(async () => second.acks, a => a.length > 0);
  assert.deepEqual(acks[0], { schema: CONNECTIONS_CAPABILITY_ACK_SCHEMA, requestId: set.requestId, hostID: second.hostId, status: "ready" });
  status = (await api(second, "GET", "/v1/connections/platform-configuration")).json;
  assert.deepEqual([status.custody.state, status.custody.generation, status.privateRequest.requestId], ["ready", 1, set.requestId]);
  // Reserved `.test` origin: the catalog read fails at the network, honestly unavailable, never a crash or fallback.
  await api(second, "GET", "/v1/connections/catalog");
  assert.equal((await api(second, "GET", "/v1/connections/status")).json.platform, "unavailable");
  // Lost acknowledgement: lock written, ACK not read; GET settles the exact id. No resend happens here.
  const lock = { ...frame(second, { operation: "lock" }) }; delete (lock as Record<string, unknown>).capability;
  writeSync(second.fifo!, JSON.stringify(lock) + "\n");
  status = await waitFor(async () => (await api(second, "GET", "/v1/connections/platform-configuration")).json, s => s.privateRequest?.requestId === lock.requestId);
  assert.deepEqual([status.privateRequest.operation, status.privateRequest.state, status.custody.state], ["lock", "locked", "locked"]);
  await stop(second);

  // Same saved configuration, launched WITHOUT the app pipe: nothing composed, the reason is explicit.
  const plain = await start(t, root, 3, false);
  status = (await api(plain, "GET", "/v1/connections/platform-configuration")).json;
  assert.deepEqual([status.custody.channel, status.runtime.state, status.runtime.reason, status.configuration.enabled], ["unavailable", "inactive", "private_channel_unavailable", true]);
  await stop(plain);
  // The capability never left the FIFO: not in stdout (ready, acks), stderr, argv, environment or the data directory files.
  for (const text of [...first.stdout, ...second.stdout, ...plain.stdout, ...first.stderr, ...second.stderr, ...plain.stderr, JSON.stringify(second.proc.spawnargs)])
    assert.ok(!text.includes(CAPABILITY));
  for (const file of ["connections-configuration.sqlite", "connections.sqlite", "dexter.sqlite"])
    assert.ok(!readFileSync(join(root, "host", file)).toString("latin1").includes(CAPABILITY), file);
});
