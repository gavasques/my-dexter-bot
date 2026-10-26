// G4 R3 local policy persistence: a change is only done once it is on disk. A write that fails throws a typed
// PolicyPersistenceError (no raw errno text), quarantines the policy for the life of the process (every check
// refuses, every bot is notified so sessions drain) and never claims the revocation was durable. Only this
// call's own temp file is cleaned; foreign files are left alone. No network.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { JsonValue } from "@dexter/contracts";
import {
  BROWSER_NAVIGATE, BROWSER_READ, CUA_STATUS, DeviceError, HandlerRefusal, LocalCapabilityPolicy, PolicyPersistenceError, createLocalCapabilities,
  checkOperationArgs, type BrowserDriver, type BrowserLaunch, type BrowserSession, type LocalBotGrant, type TrustedJobContext,
} from "@dexter/devices";

const ORIGIN = "https://granted.test";
const refused = (c: string) => (e: unknown) => e instanceof HandlerRefusal && e.code === c;
const job = (botId: string, tool: string): TrustedJobContext => Object.freeze({
  hostId: "host_lab", ownerId: "owner_lab", deviceId: "dev_lab", botId, threadId: "thr", actionId: `act_${Math.random()}`,
  requestHash: "0".repeat(64), tool, deadlineAt: Date.now() + 30_000,
});
const grant = (botId: string): LocalBotGrant =>
  ({ botId, label: "Bot", operations: [BROWSER_NAVIGATE, BROWSER_READ, CUA_STATUS], browserOrigins: [ORIGIN], cuaMaxSessionSeconds: 60 });
function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "dexter-policy-"));
  chmodSync(dir, 0o700);
  t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function load(dir: string, bots: LocalBotGrant[]) {
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify({ version: 1, bots }), { mode: 0o600 });
  return { path, policy: LocalCapabilityPolicy.load(path) };
}

test("a revocation that cannot be written is a typed failure and quarantines the policy; the file keeps the old grant", (t) => {
  const dir = temp(t);
  const { path, policy } = load(dir, [grant("bot_a"), grant("bot_b")]);
  const before = readFileSync(path, "utf8");
  const authA = policy.authorize(job("bot_a", BROWSER_READ), BROWSER_READ);
  const notified: string[][] = [];
  policy.onChange((ids) => { notified.push([...ids].sort()); });
  // A foreign file with the old fixed temp name must not be touched.
  const foreign = `${path}.${process.pid}.tmp`;
  writeFileSync(foreign, "foreign", { mode: 0o600 });
  chmodSync(dir, 0o500);
  let error: unknown;
  try { policy.revoke("bot_b"); } catch (e) { error = e; }
  chmodSync(dir, 0o700);
  assert.ok(error instanceof PolicyPersistenceError && error instanceof DeviceError);
  assert.equal(error.code, "unavailable");
  assert.equal(error.message, "local policy not persisted", "no raw errno, path or policy text");
  assert.equal(policy.quarantined, true);
  assert.deepEqual(notified, [["bot_a", "bot_b"]], "every bot is told, so every session drains");
  // Nothing holds any more in this process, for any bot, operation or origin.
  assert.equal(policy.isCurrent(authA), false);
  assert.throws(() => policy.authorize(job("bot_a", BROWSER_READ), BROWSER_READ), refused("policy_quarantined"));
  assert.throws(() => policy.authorize(job("bot_b", BROWSER_READ), BROWSER_READ), refused("policy_quarantined"));
  assert.equal(policy.originAllowed("bot_a", ORIGIN), false);
  assert.equal(policy.labelOf("bot_a"), null);
  assert.equal(policy.grantOf("bot_a"), null);
  assert.equal(policy.generation("bot_a"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(policy)), { quarantined: true, bots: [] });
  // No automatic recovery: later changes, even with a writable directory, are refused.
  assert.throws(() => { policy.replace({ version: 1, bots: [grant("bot_a")] }); }, PolicyPersistenceError);
  assert.equal(policy.quarantined, true);
  // Honest about durability: the previous policy is still on disk (operator repair before next start).
  assert.equal(readFileSync(path, "utf8"), before);
  assert.ok(LocalCapabilityPolicy.load(path).authorize(job("bot_b", BROWSER_READ), BROWSER_READ), "a restart would see the old grant");
  assert.equal(readFileSync(foreign, "utf8"), "foreign");
  assert.deepEqual(readdirSync(dir).sort(), ["policy.json", `policy.json.${process.pid}.tmp`].sort());
});

test("a write that fails after its temp file was created removes only that temp file", (t) => {
  const dir = temp(t);
  // The policy path is a non-empty directory: the temp file is written, the rename fails.
  const path = join(dir, "policy.json");
  mkdirSync(join(path, "occupied"), { recursive: true });
  const policy = new LocalCapabilityPolicy({ version: 1, bots: [grant("bot_a")] }, path);
  assert.throws(() => { policy.revoke("bot_a"); }, PolicyPersistenceError);
  assert.equal(policy.quarantined, true);
  assert.deepEqual(readdirSync(dir), ["policy.json"], "no temp file left behind");
  assert.ok(existsSync(join(path, "occupied")));
});

test("a successful revocation is persisted before it applies and survives a restart", (t) => {
  const dir = temp(t);
  const { path, policy } = load(dir, [grant("bot_a")]);
  policy.revoke("bot_a", BROWSER_READ);
  assert.equal(policy.quarantined, false);
  assert.throws(() => LocalCapabilityPolicy.load(path).authorize(job("bot_a", BROWSER_READ), BROWSER_READ), refused("not_granted"));
  assert.deepEqual(readdirSync(dir), ["policy.json"]);
});

test("quarantine drains a live browser session: the in-flight navigation result releases nothing and the next call is refused", async (t) => {
  const dir = temp(t);
  const { policy } = load(dir, [grant("bot_a"), grant("bot_b")]);
  let releaseNav!: () => void;
  let closed = 0;
  const session: BrowserSession = {
    pid: null, exited: new Promise(() => {}), gone: new Promise(() => {}), alive: true,
    navigate: (url) => new Promise((resolve) => { releaseNav = () => { resolve({ url, outcome: "loaded" }); }; }),
    read: async () => ({ url: `${ORIGIN}/`, title: "", text: "secret", truncatedAtSource: false }),
    blockedRequests: () => 0, close: async () => { closed += 1; return { forced: false }; }, kill: () => {},
  };
  const driver: BrowserDriver = { kind: "scripted", launch: async (_input: BrowserLaunch) => session };
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  const caps = createLocalCapabilities({ dataDir: join(dir, "data"), policy, browser: { driver, closeTimeoutMs: 100 } });
  t.after(() => caps.close());
  const run = (tool: string, args: Record<string, JsonValue>) =>
    caps.handlers.get(tool)!(checkOperationArgs(tool, args), { signal: new AbortController().signal, job: job("bot_a", tool) });
  const nav = run(BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  for (let i = 0; i < 100 && !releaseNav; i++) await new Promise((r) => setImmediate(r));
  chmodSync(dir, 0o500);
  assert.throws(() => { policy.revoke("bot_b"); }, PolicyPersistenceError);
  chmodSync(dir, 0o700);
  releaseNav();
  // The navigation was handed over before the quarantine: it is `unknown`, never a released page.
  await assert.rejects(nav, (e: unknown) => e instanceof Error && e.name === "OutcomeUncertain");
  assert.equal(closed, 1, "the bot's browser was closed");
  await assert.rejects(run(BROWSER_READ, { maxChars: 10 }), refused("policy_quarantined"));
  await assert.rejects(run(BROWSER_NAVIGATE, { url: `${ORIGIN}/` }), refused("policy_quarantined"));
});
