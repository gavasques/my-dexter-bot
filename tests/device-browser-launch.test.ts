// G4 browser fencing: revocation, takeover and shutdown while a bot's browser is still starting (with a
// cooperative and a non-cooperative driver), the kill fallback when a graceful close rejects, the origin
// re-check after a read, and the final URL taken from the browser's target metadata (bounded metadata-only
// retry, page script cannot widen it). R4: a navigation is confirmed only by its own loader's load event; an
// empty metadata URL is re-read, then the loader's committed URL; close resolves only when every process of
// the browser's group is gone; undrained processes quarantine the bot; a re-grant during an aborted start
// launches again. In-memory scripted driver and the synthetic CDP browser; no network.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@dexter/contracts";
import {
  BROWSER_CLOSE, BROWSER_NAVIGATE, BROWSER_READ, BrowserDriverError, ChromePipeDriver, DeviceError, HandlerRefusal, LocalCapabilityPolicy, OutcomeUncertain,
  botKeyOf, checkOperationArgs, createLocalCapabilities, type BrowserDriver, type BrowserLaunch, type BrowserSession, type LocalBotGrant,
  type NavigateResult, type PageSnapshot, type TrustedJobContext,
} from "@dexter/devices";

const ORIGIN = "https://granted.test";
const OTHER = "https://other.test";
const OPS = [BROWSER_NAVIGATE, BROWSER_READ, BROWSER_CLOSE];
const refused = (c: string) => (e: unknown) => e instanceof HandlerRefusal && e.code === c;
const anyRefusal = (e: unknown) => e instanceof HandlerRefusal;

function temp(t: TestContext, prefix = "dexter-launch-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
let counter = 0;
function job(botId: string, tool: string): TrustedJobContext {
  return Object.freeze({ hostId: "host_lab", ownerId: "owner_lab", deviceId: "dev_lab", botId, threadId: "thr_lab", actionId: `act_${++counter}`,
    requestHash: "0".repeat(64), tool, deadlineAt: Date.now() + 30_000 });
}
const grant = (botId: string, extra: Partial<LocalBotGrant> = {}): LocalBotGrant =>
  ({ botId, label: "Bot", operations: OPS, browserOrigins: [ORIGIN], cuaMaxSessionSeconds: 0, ...extra });
const lockPath = (dir: string, botId: string) =>
  join(dir, "capabilities", "browser", "locks", `${botKeyOf({ hostId: "host_lab", ownerId: "owner_lab", botId })}.lock`);
const tick = () => new Promise((r) => setImmediate(r));

// ---- scripted in-memory driver ------------------------------------------------------------------

class ScriptedSession implements BrowserSession {
  readonly pid = null;
  readonly exited: Promise<void>;
  readonly gone: Promise<void>;
  alive = true;
  /** Processes that survive close and kill: `gone` never settles. */
  undrainable = false;
  navigations: string[] = [];
  closes = 0;
  kills = 0;
  readUrl = `${ORIGIN}/`;
  closeRejects = false;
  heldRead: { resolve: (p: PageSnapshot) => void } | null = null;
  holdRead = false;
  #exit!: () => void;
  #gone!: () => void;
  constructor() {
    this.exited = new Promise((r) => { this.#exit = r; });
    this.gone = new Promise((r) => { this.#gone = r; });
  }
  private end(): void { this.alive = false; this.#exit(); if (!this.undrainable) this.#gone(); }
  async navigate(url: string): Promise<NavigateResult> { this.navigations.push(url); return { url, outcome: "loaded" }; }
  read(): Promise<PageSnapshot> {
    const page = { url: this.readUrl, title: "t", text: "secret page text", truncatedAtSource: false };
    if (!this.holdRead) return Promise.resolve(page);
    return new Promise((resolve) => { this.heldRead = { resolve: () => { resolve(page); } }; });
  }
  blockedRequests(): number { return 0; }
  async close(): Promise<{ forced: boolean }> {
    this.closes += 1;
    // A rejecting close leaves the browser running: only the kill fallback ends it.
    if (this.closeRejects) throw new BrowserDriverError("protocol");
    if (this.undrainable) { this.end(); throw new BrowserDriverError("undrained"); }
    this.end();
    return { forced: false };
  }
  kill(): void { this.kills += 1; this.end(); }
}

/** Launches wait for the test. `cooperative: false` ignores the launch signal and still returns a browser. */
class ScriptedDriver implements BrowserDriver {
  readonly kind = "scripted";
  readonly launches: Array<{ input: BrowserLaunch; session: ScriptedSession; finish: () => void; started: Promise<void> }> = [];
  readonly launched = deferred();
  constructor(private readonly cooperative: boolean, private readonly delayed = true) {}
  launch(input: BrowserLaunch): Promise<BrowserSession> {
    const session = new ScriptedSession();
    const gate = deferred();
    const entry = { input, session, finish: () => { gate.resolve(); }, started: Promise.resolve() };
    this.launches.push(entry);
    this.launched.resolve();
    if (!this.delayed) return Promise.resolve(session);
    return new Promise((resolve, reject) => {
      if (this.cooperative) input.signal.addEventListener("abort", () => { reject(new BrowserDriverError("aborted")); }, { once: true });
      void gate.promise.then(() => { resolve(session); });
    });
  }
}

function lab(t: TestContext, driver: BrowserDriver, grants = [grant("bot_a")], closeTimeoutMs = 200) {
  const dir = temp(t);
  const policy = new LocalCapabilityPolicy({ version: 1, bots: grants });
  const caps = createLocalCapabilities({ dataDir: dir, policy, browser: { driver, closeTimeoutMs } });
  t.after(() => caps.close());
  const run = (botId: string, tool: string, args: Record<string, JsonValue>) =>
    caps.handlers.get(tool)!(checkOperationArgs(tool, args), { signal: new AbortController().signal, job: job(botId, tool) });
  return { dir, policy, caps, run };
}

for (const cooperative of [true, false]) {
  const kind = cooperative ? "cooperative" : "non-cooperative";

  test(`browser launch (${kind}): takeover while starting admits no navigation and releases the lock`, async (t) => {
    const driver = new ScriptedDriver(cooperative);
    const l = lab(t, driver);
    const nav = l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
    await driver.launched.promise;
    assert.ok(existsSync(lockPath(l.dir, "bot_a")), "the profile is locked while starting");
    let takenOver = false;
    const takeover = l.caps.browser!.takeover("bot_a").then(() => { takenOver = true; });
    // Refused as soon as the takeover lands, before the start settles; never `unknown`, nothing was sent.
    await assert.rejects(nav, refused("takeover"));
    if (!cooperative) {
      await tick();
      assert.equal(takenOver, false, "takeover waits for the late browser");
      driver.launches[0]!.finish();
    }
    await takeover;
    const session = driver.launches[0]!.session;
    assert.deepEqual(session.navigations, []);
    if (!cooperative) assert.equal(session.alive, false, "the late browser was closed");
    assert.equal(existsSync(lockPath(l.dir, "bot_a")), false, "lock released");
    assert.deepEqual(l.caps.browser!.status().sessions, []);
    // The bot can start again afterwards with a fresh generation.
    const next = l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/again` });
    await tick();
    driver.launches[1]!.finish();
    assert.deepEqual(((await next) as Record<string, unknown>).session, { generation: 2 });
  });

  test(`browser launch (${kind}): revocation while starting refuses; a late browser is closed, never used`, async (t) => {
    const driver = new ScriptedDriver(cooperative);
    const l = lab(t, driver, [grant("bot_a"), grant("bot_b")]);
    const nav = l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
    await driver.launched.promise;
    l.policy.revoke("bot_a", BROWSER_CLOSE);
    await assert.rejects(nav, refused("revoked"));
    assert.equal(driver.launches[0]!.input.allowRequest(`${ORIGIN}/x`), false, "the starting browser may not fetch anything");
    driver.launches[0]!.finish();
    await l.caps.browser!.takeover("bot_a");
    const session = driver.launches[0]!.session;
    assert.deepEqual(session.navigations, []);
    if (!cooperative) assert.equal(session.closes, 1);
    assert.equal(session.alive, cooperative ? true : false);
    assert.equal(existsSync(lockPath(l.dir, "bot_a")), false);
    assert.deepEqual(l.caps.browser!.status().sessions, []);
  });

  test(`browser launch (${kind}): daemon shutdown waits for a start in progress and leaves nothing running`, async (t) => {
    const driver = new ScriptedDriver(cooperative);
    const l = lab(t, driver);
    const nav = l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
    await driver.launched.promise;
    let closed = false;
    const closing = l.caps.close().then(() => { closed = true; });
    await assert.rejects(nav, anyRefusal);
    if (!cooperative) {
      await tick();
      assert.equal(closed, false, "close drains the late launch");
      driver.launches[0]!.finish();
    }
    await closing;
    const session = driver.launches[0]!.session;
    assert.deepEqual(session.navigations, []);
    if (!cooperative) assert.equal(session.alive, false);
    assert.equal(existsSync(lockPath(l.dir, "bot_a")), false);
    await assert.rejects(l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` }), refused("capability_closed"));
  });
}

test("browser teardown: a rejecting graceful close falls back to kill, awaits exit, then releases the lock", async (t) => {
  const driver = new ScriptedDriver(true, false);
  const l = lab(t, driver);
  await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  const session = driver.launches[0]!.session;
  session.closeRejects = true;
  await l.caps.browser!.takeover("bot_a");
  assert.equal(session.closes, 1);
  assert.equal(session.kills, 1, "killed after the close rejected");
  assert.equal(session.alive, false);
  assert.equal(existsSync(lockPath(l.dir, "bot_a")), false);
});

test("browser teardown: processes that cannot be shown gone quarantine the bot; its lock stays and stop reports the failure", async (t) => {
  const driver = new ScriptedDriver(true, false);
  const dir = temp(t);
  const policy = new LocalCapabilityPolicy({ version: 1, bots: [grant("bot_a"), grant("bot_b")] });
  const caps = createLocalCapabilities({ dataDir: dir, policy, browser: { driver, closeTimeoutMs: 50 } });
  const run = (botId: string, tool: string, args: Record<string, JsonValue>) =>
    caps.handlers.get(tool)!(checkOperationArgs(tool, args), { signal: new AbortController().signal, job: job(botId, tool) });
  await run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  await run("bot_b", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  const session = driver.launches[0]!.session;
  session.undrainable = true;
  // Told to close, not shown closed: unknown, never a confirmed close.
  await assert.rejects(run("bot_a", BROWSER_CLOSE, {}), (e: unknown) => e instanceof OutcomeUncertain && e.code === "browser_undrained");
  assert.equal(session.kills, 1, "killed after the close could not drain");
  assert.ok(existsSync(lockPath(dir, "bot_a")), "the profile lock stays held");
  assert.equal(caps.browser!.status().quarantined, 1);
  await assert.rejects(run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` }), refused("browser_quarantined"));
  assert.equal(driver.launches.length, 2, "no new browser for the quarantined bot");
  await assert.rejects(caps.browser!.takeover("bot_a"), (e: unknown) => e instanceof DeviceError && e.code === "unavailable");
  // Another bot is unaffected.
  await caps.browser!.takeover("bot_b");
  assert.equal(existsSync(lockPath(dir, "bot_b")), false);
  await assert.rejects(caps.close(), (e: unknown) => e instanceof DeviceError && e.code === "unavailable");
  assert.ok(existsSync(lockPath(dir, "bot_a")), "still held after stop");
});

test("browser launch: a start that leaves processes behind quarantines the bot and keeps its lock", async (t) => {
  const driver: BrowserDriver = { kind: "scripted", launch: async () => { throw new BrowserDriverError("undrained"); } };
  const dir = temp(t);
  const policy = new LocalCapabilityPolicy({ version: 1, bots: [grant("bot_a")] });
  const caps = createLocalCapabilities({ dataDir: dir, policy, browser: { driver, closeTimeoutMs: 50 } });
  const run = (tool: string, args: Record<string, JsonValue>) =>
    caps.handlers.get(tool)!(checkOperationArgs(tool, args), { signal: new AbortController().signal, job: job("bot_a", tool) });
  await assert.rejects(run(BROWSER_NAVIGATE, { url: `${ORIGIN}/` }), refused("browser_quarantined"));
  assert.ok(existsSync(lockPath(dir, "bot_a")));
  await assert.rejects(run(BROWSER_READ, { maxChars: 10 }), refused("browser_quarantined"));
  await assert.rejects(caps.close(), (e: unknown) => e instanceof DeviceError && e.code === "unavailable");
});

test("browser launch: re-granting while an aborted start is still settling starts a new browser instead of refusing", async (t) => {
  const driver = new ScriptedDriver(false);
  const l = lab(t, driver);
  const first = l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  await driver.launched.promise;
  l.policy.revoke("bot_a");
  await assert.rejects(first, refused("revoked"));
  l.policy.replace({ version: 1, bots: [grant("bot_a")] });
  let settled: { value?: unknown; error?: unknown } | null = null;
  const second = l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/second` })
    .then((value) => (settled = { value }), (error: unknown) => (settled = { error }));
  await tick();
  assert.equal(driver.launches.length, 1, "waits for the aborted start to settle, never joins it");
  driver.launches[0]!.finish();
  const end = Date.now() + 5_000;
  while (driver.launches.length < 2 && settled === null && Date.now() < end) await tick();
  const early = settled as { error?: unknown } | null;
  assert.equal(early === null ? "pending" : early.error instanceof HandlerRefusal ? early.error.code : "settled", "pending",
    "the re-granted navigation is not refused by the aborted start");
  assert.equal(driver.launches.length, 2, "a new browser was started");
  driver.launches[1]!.finish();
  const outcome = await second;
  assert.ok("value" in outcome, "the re-granted navigation completed");
  const result = outcome.value as Record<string, unknown>;
  assert.equal(result.outcome, "loaded");
  assert.deepEqual(result.session, { generation: 2 });
  assert.deepEqual(driver.launches[0]!.session.navigations, [], "the aborted browser was never used");
  assert.equal(driver.launches[0]!.session.alive, false, "and was closed");
  assert.deepEqual(driver.launches[1]!.session.navigations, [`${ORIGIN}/second`]);
});

test("browser read: the page's origin is checked again after the read; an ungranted or revoked origin releases nothing", async (t) => {
  const driver = new ScriptedDriver(true, false);
  const l = lab(t, driver);
  await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  const session = driver.launches[0]!.session;
  const ok = await l.run("bot_a", BROWSER_READ, { maxChars: 100 }) as Record<string, unknown>;
  assert.equal(ok.origin, ORIGIN);
  session.readUrl = `${OTHER}/moved`;
  await assert.rejects(l.run("bot_a", BROWSER_READ, { maxChars: 100 }), refused("origin_not_granted"));
  for (const url of ["about:blank", "chrome://settings", "", "not a url"]) {
    session.readUrl = url;
    await assert.rejects(l.run("bot_a", BROWSER_READ, { maxChars: 100 }), refused("origin_not_granted"));
  }
});

// ---- synthetic CDP browser: final URL from target metadata ---------------------------------------

const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-cdp-browser.js", import.meta.url));
function fakeExecutable(t: TestContext, site: Record<string, unknown>) {
  const dir = temp(t, "dexter-fake-browser-");
  const executable = join(dir, "fake-browser.mjs");
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(FAKE_BROWSER, "utf8")}`, { mode: 0o755 });
  writeFileSync(join(dir, "site.json"), JSON.stringify(site));
  const log = () => existsSync(join(dir, "log.jsonl"))
    ? readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").slice(0, -1).map((x) => JSON.parse(x) as Record<string, unknown>) : [];
  return { executable, log };
}
const PAGES = {
  [`${ORIGIN}/`]: { title: "Home", text: "home" },
  [`${ORIGIN}/redirect`]: { redirect: `${OTHER}/landing` },
  [`${ORIGIN}/cookie`]: { title: "C", text: "cookie" },
  [`${ORIGIN}/drift`]: { title: "D", text: "drift", driftTo: `${OTHER}/elsewhere` },
  [`${OTHER}/elsewhere`]: { title: "Spoof", text: "foreign secret", scriptUrl: `${ORIGIN}/` },
};

test("chrome driver: transient metadata errors after a blocked redirect are retried as metadata only, never as a navigation", async (t) => {
  // Two failures (the reviewer's pattern: one right after the blocked redirect, one on the next navigation).
  const fake = fakeExecutable(t, { pages: PAGES, targetInfoErrors: 2 });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  const blocked = await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/redirect` }) as Record<string, unknown>;
  assert.equal(blocked.outcome, "blocked");
  const loaded = await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/cookie` }) as Record<string, unknown>;
  assert.equal(loaded.outcome, "loaded");
  assert.equal(loaded.url, `${ORIGIN}/cookie`);
  const commands = fake.log().filter((e) => e.event === "command");
  assert.equal(commands.filter((e) => e.method === "Page.navigate").length, 2, "each navigation was sent exactly once");
  assert.equal(fake.log().filter((e) => e.event === "target_info_error").length, 2);
});

test("chrome driver: target metadata unreadable after bounded retries falls back to the loader's committed URL", async (t) => {
  const fake = fakeExecutable(t, { pages: PAGES, targetInfoErrors: 3 });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  const loaded = await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/cookie` }) as Record<string, unknown>;
  assert.deepEqual([loaded.outcome, loaded.url], ["loaded", `${ORIGIN}/cookie`]);
  assert.equal(fake.log().filter((e) => e.event === "command" && e.method === "Page.navigate").length, 1);
  assert.equal(fake.log().filter((e) => e.event === "command" && e.method === "Target.getTargetInfo").length, 3, "bounded retries");
});

test("chrome driver: a successful metadata answer with an empty URL is re-read (metadata only), never taken as the URL", async (t) => {
  const fake = fakeExecutable(t, { pages: PAGES, targetInfoEmpty: 2 });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  const loaded = await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/cookie` }) as Record<string, unknown>;
  assert.deepEqual([loaded.outcome, loaded.url], ["loaded", `${ORIGIN}/cookie`]);
  assert.equal(fake.log().filter((e) => e.event === "target_info_empty").length, 2);
  assert.equal(fake.log().filter((e) => e.event === "command" && e.method === "Target.getTargetInfo").length, 3);
  assert.equal(fake.log().filter((e) => e.event === "command" && e.method === "Page.navigate").length, 1);
  // A read whose metadata stays empty releases nothing (no committed fallback for reads).
  const fake2 = fakeExecutable(t, { pages: PAGES });
  const l2 = lab(t, new ChromePipeDriver({ executable: fake2.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  await l2.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  const read = await l2.run("bot_a", BROWSER_READ, { maxChars: 100 }) as Record<string, unknown>;
  assert.equal(read.url, `${ORIGIN}/`);
});

test("chrome driver: the error page's late load after a refused redirect does not confirm the next navigation", async (t) => {
  const pages = { ...PAGES, [`${ORIGIN}/slow`]: { hangLoad: true } };
  const fake = fakeExecutable(t, { pages, staleErrorLoad: true });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  assert.equal((await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/redirect` }) as Record<string, unknown>).outcome, "blocked");
  // The next page never loads; only the stale error-page load arrives. Nothing interrupts the navigation but
  // its own short deadline: it must end unconfirmed (unknown), never `loaded` on the error page's event.
  const tool = BROWSER_NAVIGATE;
  const shortJob = { ...job("bot_a", tool), deadlineAt: Date.now() + 5_000 };
  const outcome = await l.caps.handlers.get(tool)!(checkOperationArgs(tool, { url: `${ORIGIN}/slow` }), { signal: new AbortController().signal, job: Object.freeze(shortJob) })
    .then((value) => ({ value }), (error: unknown) => ({ error }));
  assert.ok(fake.log().some((e) => e.event === "stale_load"), "the stale load was delivered");
  assert.ok(fake.log().some((e) => e.event === "hang"), "the page was reached and never loaded");
  assert.ok("error" in outcome && outcome.error instanceof OutcomeUncertain && outcome.error.code === "deadline",
    `not confirmed by the stale load: ${JSON.stringify("value" in outcome ? outcome.value : String(outcome.error))}`);
  // With a page that does load, the result is its own load and URL.
  const fake2 = fakeExecutable(t, { pages: PAGES, staleErrorLoad: true });
  const l2 = lab(t, new ChromePipeDriver({ executable: fake2.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  await l2.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/redirect` });
  const loaded = await l2.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/cookie` }) as Record<string, unknown>;
  assert.deepEqual([loaded.outcome, loaded.url], ["loaded", `${ORIGIN}/cookie`]);
  assert.equal(fake2.log().filter((e) => e.event === "command" && e.method === "Page.navigate").length, 2);
});

const pidGone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } };

test("chrome driver: close waits for every process of the browser's group; a lingering helper is killed (forced)", async (t) => {
  const fake = fakeExecutable(t, { pages: PAGES, helper: "linger" });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }), [grant("bot_a")], 300);
  await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  const helperPid = fake.log().find((e) => e.event === "helper")!.helperPid as number;
  // Cleanup only: a regression that leaves the helper alive must fail the assertions, not hang the run.
  t.after(() => { try { process.kill(helperPid, "SIGKILL"); } catch { /* gone */ } });
  assert.equal(pidGone(helperPid), false, "the helper runs");
  const closed = await l.run("bot_a", BROWSER_CLOSE, {}) as Record<string, unknown>;
  assert.equal(closed.forced, true, "the main process exited, the helper did not: forced");
  assert.equal(pidGone(helperPid), true, "no process of the group is left when close resolves");
  assert.equal(existsSync(lockPath(l.dir, "bot_a")), false);
});

test("chrome driver: a graceful close resolves only after the helper finished its write and exited", async (t) => {
  const fake = fakeExecutable(t, { pages: PAGES, helper: "flush" });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }), [grant("bot_a")], 10_000);
  await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` });
  const helperPid = fake.log().find((e) => e.event === "helper")!.helperPid as number;
  // Cleanup only: a regression that leaves the helper alive must fail the assertions, not hang the run.
  t.after(() => { try { process.kill(helperPid, "SIGKILL"); } catch { /* gone */ } });
  const closed = await l.run("bot_a", BROWSER_CLOSE, {}) as Record<string, unknown>;
  assert.equal(closed.forced, false);
  assert.ok(existsSync(join(fake.executable, "..", "helper-flushed")), "the helper's write happened before close resolved");
  assert.equal(pidGone(helperPid), true);
});

test("chrome driver: the page's own location cannot widen the origin; target metadata decides", async (t) => {
  const fake = fakeExecutable(t, { pages: PAGES });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  const nav = await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/drift` }) as Record<string, unknown>;
  assert.deepEqual([nav.outcome, nav.url], ["loaded", null], "the target ended on an ungranted origin");
  // The page script claims a granted location; the read is refused and its text never released.
  await assert.rejects(l.run("bot_a", BROWSER_READ, { maxChars: 100 }), refused("origin_not_granted"));
  const home = await l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/` }) as Record<string, unknown>;
  assert.equal(home.url, `${ORIGIN}/`);
  const read = await l.run("bot_a", BROWSER_READ, { maxChars: 100 }) as Record<string, Record<string, unknown>>;
  assert.equal(read.content!.text, "home");
});

test("an unconfirmed navigation is still unknown (never retried) after the R3 changes", async (t) => {
  const fake = fakeExecutable(t, { pages: { [`${ORIGIN}/slow`]: { hangLoad: true } } });
  const l = lab(t, new ChromePipeDriver({ executable: fake.executable, launchTimeoutMs: 10_000, commandTimeoutMs: 10_000 }));
  const pending = assert.rejects(l.run("bot_a", BROWSER_NAVIGATE, { url: `${ORIGIN}/slow` }), (e: unknown) => e instanceof OutcomeUncertain);
  const end = Date.now() + 10_000;
  while (!fake.log().some((e) => e.event === "hang")) { if (Date.now() > end) throw new Error("no hang"); await tick(); }
  await l.caps.browser!.takeover("bot_a");
  await pending;
  assert.equal(fake.log().filter((e) => e.event === "command" && e.method === "Page.navigate").length, 1);
});
