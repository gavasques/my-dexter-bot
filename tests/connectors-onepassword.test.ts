import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import {
  ComposioSessionAdapter, ComposioSessionDirectory, ConnectorError, OnePasswordBroker, OpCliSecretReader, checkOpRef, composioUserId,
  type SecretReader,
} from "@dexter/connectors";

// Synthetic values only. The fake `op` below is a shell script in a temp dir; the real 1Password CLI is never run.
const SECRET = "synthetic-op-secret-3d8b21";
const REF = "op://Dexter Test/composio/api-key";
const HOST = "backend.composio.dev";
type Ctx = { after: (fn: () => void) => void };

const code = (expected: string) => (e: unknown) =>
  e instanceof ConnectorError && e.code === expected && !e.message.includes(SECRET) && !e.message.includes("op://");

test("op refs: only pinned vault/item/[section/]field references are accepted", () => {
  for (const ok of [REF, "op://dev/Stripe/publishable-key", "op://Management/PagerDuty/Admin/email", "op://a1b2c3/item_x/field.v2"]) assert.equal(checkOpRef(ok), ok);
  for (const bad of [
    "op://dev/db/password?attribute=otp", "op://$APP_ENV/mysql/password", "op://dev/../password", "op://dev/item", "op://a/b/c/d/e",
    "op://dev//field", "https://dev/item/field", "op://dev/item/ field", "op://dev/item/fi/eld\n", `op://dev/item/${"x".repeat(600)}`, 42,
  ]) assert.throws(() => checkOpRef(bad), code("invalid_config"), String(bad));
});

class FakeReader implements SecretReader {
  reads: string[] = [];
  value: string | Error = SECRET;
  gate: Promise<void> | null = null;
  async read(ref: string): Promise<string> {
    this.reads.push(ref);
    if (this.gate) await this.gate;
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}
function broker(reader: SecretReader, clock: { t: number }, extra: { scheme?: "Bearer" } = {}) {
  return new OnePasswordBroker({
    reader, ttlMs: 1_000, now: () => clock.t,
    bindings: [{ credentialRef: "cred-a", opRef: REF, header: "authorization", allowedHosts: [HOST], ...extra }],
  });
}

test("op broker: sync acquire fails closed until warmed, honours host allowlist and TTL, and never reads unbound refs", async () => {
  const clock = { t: 0 };
  const reader = new FakeReader();
  const b = broker(reader, clock, { scheme: "Bearer" });
  assert.equal(b.acquire("cred-a", HOST), null);
  assert.deepEqual(b.status(), [{ credentialRef: "cred-a", state: "cold", expiresAt: null }]);
  assert.deepEqual(await b.warm(), [{ credentialRef: "cred-a", ok: true, code: null }]);
  assert.deepEqual(b.acquire("cred-a", HOST)?.headers, { authorization: `Bearer ${SECRET}` });
  assert.ok(Object.isFrozen(b.acquire("cred-a", HOST)!.headers));
  assert.equal(b.acquire("cred-a", "evil.test"), null);
  assert.equal(b.acquire(REF, HOST), null, "an op:// ref is never a broker key");
  assert.deepEqual(await b.warm([REF, "cred-missing"]), [
    { credentialRef: REF, ok: false, code: "config_missing" }, { credentialRef: "cred-missing", ok: false, code: "config_missing" },
  ]);
  assert.deepEqual(reader.reads, [REF], "only the pinned reference was ever read");
  assert.deepEqual([...b.secretValues()].sort(), [`Bearer ${SECRET}`, SECRET].sort());
  assert.ok(!JSON.stringify(b.status()).includes(SECRET));
  clock.t = 1_000;
  assert.equal(b.acquire("cred-a", HOST), null);
  assert.equal(b.status()[0]!.state, "expired");
});

test("op broker: single flight, revoke/clear discard in-flight reads, failed refresh drops the old value, header-unsafe values refused", async () => {
  const clock = { t: 0 };
  const reader = new FakeReader();
  const b = broker(reader, clock);
  let open!: () => void;
  reader.gate = new Promise((r) => { open = r; });
  const [w1, w2] = [b.warm(), b.warm()];
  open();
  assert.deepEqual((await Promise.all([w1, w2])).flat().map((r) => r.ok), [true, true]);
  assert.equal(reader.reads.length, 1, "concurrent warms share one read");

  reader.value = new Error(`op failed: ${SECRET}`);
  assert.deepEqual(await b.warm(), [{ credentialRef: "cred-a", ok: false, code: "op_failed" }]);
  assert.equal(b.acquire("cred-a", HOST), null, "failed refresh is fail-closed");
  assert.deepEqual(b.secretValues(), []);

  for (const bad of ["two\nlines", " padded", "", "x".repeat(9000), "tab\there"]) {
    reader.value = bad;
    assert.deepEqual(await b.warm(), [{ credentialRef: "cred-a", ok: false, code: "op_value_refused" }]);
  }

  reader.value = SECRET;
  reader.gate = new Promise((r) => { open = r; });
  const clearing = b.warm();
  b.clear();
  open();
  assert.equal((await clearing)[0]!.ok, false);
  assert.equal(b.acquire("cred-a", HOST), null);

  reader.gate = new Promise((r) => { open = r; });
  const revoking = b.warm();
  b.revoke("cred-a");
  open();
  assert.deepEqual(await revoking, [{ credentialRef: "cred-a", ok: false, code: "credential_revoked" }]);
  assert.deepEqual(await b.warm(), [{ credentialRef: "cred-a", ok: false, code: "credential_revoked" }]);
  assert.equal(b.acquire("cred-a", HOST), null);
  assert.equal(b.status()[0]!.state, "revoked");
});

test("op broker: a reader that throws synchronously never wedges single-flight; a later warm succeeds and revoke still wins in flight", async () => {
  const clock = { t: 0 };
  let reads = 0;
  let failSync = true;
  let open: (() => void) | null = null;
  const reader: SecretReader = {
    read() {
      reads += 1;
      if (failSync) throw new Error(`sync failure ${SECRET}`);
      return new Promise((resolve) => { open = () => resolve(SECRET); });
    },
  };
  const b = broker(reader, clock);
  assert.deepEqual(await b.warm(), [{ credentialRef: "cred-a", ok: false, code: "op_failed" }]);
  // Concurrent warms during a synchronous failure still share one read and both fail.
  assert.deepEqual((await Promise.all([b.warm(), b.warm()])).flat().map((r) => r.ok), [false, false]);
  assert.equal(reads, 2);
  failSync = false;
  const next = b.warm();
  await new Promise((r) => setImmediate(r));
  open!();
  assert.deepEqual(await next, [{ credentialRef: "cred-a", ok: true, code: null }], "the transient failure was not cached as in flight");
  assert.equal(reads, 3);
  assert.ok(b.acquire("cred-a", HOST));
  // Revoke during an in-flight read discards it, and the binding stays revoked.
  clock.t = 1_000;
  const late = b.warm();
  const shared = b.warm();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 4, "single flight still holds after recovery");
  b.revoke("cred-a");
  open!();
  assert.deepEqual(await late, [{ credentialRef: "cred-a", ok: false, code: "credential_revoked" }]);
  assert.deepEqual(await shared, [{ credentialRef: "cred-a", ok: false, code: "credential_revoked" }]);
  assert.deepEqual(await b.warm(), [{ credentialRef: "cred-a", ok: false, code: "credential_revoked" }]);
  assert.equal(reads, 4);
  assert.equal(b.acquire("cred-a", HOST), null);
});

test("op broker: bindings are validated at construction", () => {
  const reader = new FakeReader();
  const make = (over: Record<string, unknown>) => () => new OnePasswordBroker({
    reader, bindings: [{ credentialRef: "c", opRef: REF, header: "x-api-key", allowedHosts: [HOST], ...over } as never],
  });
  for (const over of [{ opRef: "op://v/i/f?attribute=otp" }, { header: "Host" }, { header: "content-length" }, { header: "x api" },
    { allowedHosts: [] }, { allowedHosts: ["https://backend.composio.dev"] }, { credentialRef: "../x" }, { scheme: "Digest" }]) {
    assert.throws(make(over), code("invalid_config"), JSON.stringify(over));
  }
  assert.throws(() => new OnePasswordBroker({ reader, ttlMs: 0, bindings: [] }), code("invalid_config"));
});

/** A synthetic stand-in for the `op` binary. It never contacts 1Password. */
function fakeOp(t: Ctx): { dir: string; command: string } {
  const dir = mkdtempSync(join(tmpdir(), "dexter-fake-op-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = join(dir, "op");
  writeFileSync(command, `#!/bin/sh
# Synthetic test double of the 1Password CLI. Test use only.
[ "$1" = "read" ] && [ "$2" = "--no-newline" ] && [ "$#" = "3" ] || { echo "unexpected args $*" >&2; exit 64; }
case "$3" in
  "${REF}") printf '%s' '${SECRET}' ;;
  "op://Dexter Test/probe/env") printf '%s' "\${DX_TRUSTED:-none}-\${DX_LEAK_PROBE:-none}" ;;
  "op://Dexter Test/fail/value") echo "[ERROR] item ${SECRET} not readable at $3" >&2; exit 1 ;;
  "op://Dexter Test/slow/value") /bin/sleep 30 & echo $! > "$DX_PIDFILE"; /bin/sleep 30 ;;
  "op://Dexter Test/orphan/value") /bin/sleep 30 & echo $! > "$DX_PIDFILE"; printf '%s' 'orphan-ok' ;;
  "op://Dexter Test/big/value") /bin/dd if=/dev/zero bs=1024 count=64 2>/dev/null ;;
  "op://Dexter Test/noisy/value") /bin/dd if=/dev/zero bs=1024 count=64 1>&2 2>/dev/null; printf '%s' 'x' ;;
  *) echo "not found" >&2; exit 1 ;;
esac
`);
  chmodSync(command, 0o700);
  return { dir, command };
}
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
const never = new AbortController().signal;

test("op runner: absolute command, no shell, trusted env only, fixed errors without stderr or value", async (t) => {
  const { dir, command } = fakeOp(t);
  process.env.DX_LEAK_PROBE = "leaked";
  t.after(() => { delete process.env.DX_LEAK_PROBE; });
  const reader = new OpCliSecretReader({ command, env: { DX_TRUSTED: "yes", DX_PIDFILE: join(dir, "pid") }, timeoutMs: 2_000 });
  assert.equal(await reader.read(REF, never), SECRET);
  assert.equal(await reader.read("op://Dexter Test/probe/env", never), "yes-none", "host environment is not inherited");
  await assert.rejects(reader.read("op://Dexter Test/fail/value", never), code("op_failed"));
  await assert.rejects(reader.read("op://Dexter Test/big/value", never), code("op_output_too_large"));
  await assert.rejects(reader.read("op://Dexter Test/noisy/value", never), code("op_output_too_large"));
  await assert.rejects(reader.read("op://dev/db/password?attribute=otp", never), code("invalid_config"));
  await assert.rejects(new OpCliSecretReader({ command: join(dir, "missing-op") }).read(REF, never), code("op_spawn_failed"));
  assert.throws(() => new OpCliSecretReader({ command: "op" }), code("invalid_config"));
  assert.throws(() => new OpCliSecretReader({ command, account: "--format json" }), code("invalid_config"));
});

test("op runner: timeout, abort and normal exit kill the whole process group", async (t) => {
  const { dir, command } = fakeOp(t);
  const pidfile = join(dir, "pid");
  const reader = new OpCliSecretReader({ command, env: { DX_PIDFILE: pidfile }, timeoutMs: 300, killGraceMs: 50 });
  const started = Date.now();
  await assert.rejects(reader.read("op://Dexter Test/slow/value", never), code("op_timeout"));
  assert.ok(Date.now() - started < 5_000);
  assert.ok(await gone(Number(readFileSync(pidfile, "utf8"))), "descendant killed on timeout");

  rmSync(pidfile);
  const ac = new AbortController();
  const pending = reader.read("op://Dexter Test/slow/value", ac.signal);
  for (let i = 0; i < 40 && !existsSync(pidfile); i += 1) await new Promise((r) => setTimeout(r, 25));
  ac.abort();
  await assert.rejects(pending, code("op_aborted"));
  assert.ok(await gone(Number(readFileSync(pidfile, "utf8"))), "descendant killed on abort");

  rmSync(pidfile);
  const slowReader = new OpCliSecretReader({ command, env: { DX_PIDFILE: pidfile }, timeoutMs: 5_000 });
  assert.equal(await slowReader.read("op://Dexter Test/orphan/value", never), "orphan-ok");
  assert.ok(await gone(Number(readFileSync(pidfile, "utf8"))), "descendant left behind by a successful read is killed");
  await assert.rejects(reader.read(REF, AbortSignal.abort()), code("op_aborted"));
});

test("op + composio + gateway: fake op feeds the broker; only the authorized result reaches the engine; nothing on disk", async (t) => {
  const { command } = fakeOp(t);
  const dir = mkdtempSync(join(tmpdir(), "dexter-connectors-op-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HostStore({ dataDir: dir });
  const broker = new OnePasswordBroker({
    reader: new OpCliSecretReader({ command, timeoutMs: 2_000 }),
    bindings: [{ credentialRef: "cred-composio", opRef: REF, header: "x-api-key", allowedHosts: [HOST] }],
  });
  const seen: string[] = [];
  const sessions = { dir: new ComposioSessionDirectory([]), find(s: never, c: string) { return this.dir.find(s, c); } };
  const adapter = new ComposioSessionAdapter({
    sessions,
    fetch: async (_url, init) => {
      seen.push((init.headers as Record<string, string>)["x-api-key"] === SECRET ? "key-ok" : "key-wrong");
      return new Response(JSON.stringify({ data: { sent: true, debug: SECRET }, error: null, successful: true }), { headers: { "content-type": "application/json" } });
    },
  });
  const gateway = new CapabilityGateway({ store, broker, adapter });
  t.after(() => { gateway.close(); store.close(); });
  gateway.registerTool({
    name: "slack.send_message", toolkit: "slack", upstreamSlug: "SLACK_SEND_MESSAGE", version: "20260901_00", description: "Send",
    upstreamHost: HOST, effect: "write", destinationArgument: null, destinationOrigins: null,
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 500 } } },
  });
  const bot = store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const conn = gateway.connectAccount({ profileId: "work", toolkit: "slack", label: "Work", upstreamAccountRef: "ca_w", credentialRef: "cred-composio", allowedHosts: [HOST] });
  sessions.dir = new ComposioSessionDirectory([{
    installationId: store.hostId, ownerId: store.ownerId, profileId: "work", botId: bot.id, connectionId: conn.id, toolkit: "slack",
    upstreamUserId: composioUserId(store.hostId, store.ownerId, "work"), connectedAccountId: "ca_w", sessionId: "trs_w", tools: [{ slug: "SLACK_SEND_MESSAGE", version: "20260901_00" }],
  }]);
  store.setGrant({ botId: bot.id, tool: "slack.send_message", destination: conn.id, policy: "allow" });
  assert.deepEqual((await broker.warm()).map((r) => r.ok), [true]);
  const thread = store.createThread(bot.id);
  const { turn } = store.createTurn(thread.id, { clientRequestId: "r1", content: "go" });
  store.claimNextTurn(thread.id);
  const { token } = gateway.issueCapability({ turnId: turn.id });

  // A model that names an op:// reference only sends text; the broker never reads it.
  const ok = await gateway.call(token, { tool: "slack.send_message", connectionId: conn.id, callId: "c1", arguments: { text: "op://Private/bank/password" } });
  assert.equal(ok.status, "succeeded");
  assert.deepEqual(ok.result, { sent: true, debug: "[redacted]" });
  assert.deepEqual(seen, ["key-ok"]);
  // The secret itself is refused as an argument before anything is stored.
  await assert.rejects(gateway.call(token, { tool: "slack.send_message", connectionId: conn.id, callId: "c2", arguments: { text: `x ${SECRET}` } }));
  assert.equal(seen.length, 1);
  const leaks = readdirSync(dir).filter((f) => readFileSync(join(dir, f)).includes(Buffer.from(SECRET)) || readFileSync(join(dir, f)).includes(Buffer.from(REF)));
  assert.deepEqual(leaks, []);
});
