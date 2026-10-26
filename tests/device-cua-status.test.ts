// G4 R3 `mac.cua.status`: a bot acquires its own operator-approved surface id end to end, without reading
// helper events. Status prompts are bounded (one per bot, a deadline, withdrawn on any grant change), late or
// stale approvals start nothing, and nothing about another bot's session, labels or apps is released. R4: a
// denied or lapsed prompt is never renewed on the bot's initiative (status only reports it) until the owner
// re-arms it or changes the bot's grant; the daemon's own clock closes a prompt whose helper event is missing. The
// optional check drives the real Swift helper in fixture mode (DEXTER_CUA_HELPER): no AX, screen or input.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { JsonValue } from "@dexter/contracts";
import {
  CUA_CONTROL, CUA_OBSERVE, CUA_PROTOCOL_VERSION, CUA_STATUS, CuaHelperProcess, CuaTransportError, HandlerRefusal, LocalCapabilityPolicy, botKeyOf,
  PolicyPersistenceError, checkOperationArgs, createLocalCapabilities, type CuaTransport, type LocalBotGrant, type TrustedJobContext,
} from "@dexter/devices";

const refused = (c: string) => (e: unknown) => e instanceof HandlerRefusal && e.code === c;
const tick = () => new Promise((r) => setImmediate(r));
const SESSION = `cus_${"b".repeat(32)}`;
const SURFACE = `srf_${"5".repeat(32)}`;

function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cua-status-"));
  chmodSync(dir, 0o700);
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
let counter = 0;
const job = (botId: string, tool: string): TrustedJobContext => Object.freeze({
  hostId: "host_lab", ownerId: "owner_lab", deviceId: "dev_lab", botId, threadId: "thr_lab", actionId: `act_${++counter}`,
  requestHash: "0".repeat(64), tool, deadlineAt: Date.now() + 30_000,
});
const ALL = [CUA_STATUS, CUA_OBSERVE, CUA_CONTROL];
const grant = (botId: string, extra: Partial<LocalBotGrant> = {}): LocalBotGrant =>
  ({ botId, label: `Rotulo ${botId.slice(-1)}`, operations: ALL, browserOrigins: [], cuaMaxSessionSeconds: 120, ...extra });
const keyOf = (botId: string) => botKeyOf({ hostId: "host_lab", ownerId: "owner_lab", botId });

/** In-process helper with the v2 protocol: one prompt or session at a time, prompt deadline, check, cancel. */
class Helper implements CuaTransport {
  alive = true;
  locked = false;
  holdCheck = false;
  holdConsent = false;
  /** A non-cooperative helper: its answers still arrive after the daemon aborted the request. */
  ignoreAbort = false;
  held: (() => void) | null = null;
  prompt: { botKey: string; expiresAt: number } | null = null;
  session: { sessionId: string; botKey: string; surfaceId: string; expiresAt: number } | null = null;
  readonly requests: Array<Record<string, JsonValue>> = [];
  private readonly listeners = new Set<(e: Record<string, unknown>) => void>();
  private readonly exits = new Set<() => void>();
  constructor(private readonly now: () => number) {}
  request(m: Record<string, JsonValue>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new CuaTransportError("closed"));
    this.requests.push(m);
    return new Promise((resolve, reject) => {
      if (!this.ignoreAbort) signal.addEventListener("abort", () => { reject(new CuaTransportError("aborted")); }, { once: true });
      const refuse = (code: string) => { resolve({ ok: false, code, effect: "none" }); };
      switch (m.op) {
        case "request_consent":
          if (this.prompt || this.session) { refuse("busy"); return; }
          if (this.locked) { refuse("screen_locked"); return; }
          this.prompt = { botKey: String(m.botKey), expiresAt: this.now() + Number(m.promptSeconds) * 1000 };
          if (this.holdConsent) { const p = this.prompt; this.held = () => { resolve({ ok: true, pending: true, promptExpiresAt: p.expiresAt }); }; return; }
          resolve({ ok: true, pending: true, promptExpiresAt: this.prompt.expiresAt });
          return;
        case "cancel_consent": if (this.prompt?.botKey === m.botKey) this.prompt = null; resolve({ ok: true }); return;
        case "end_session": if (this.session?.sessionId === m.sessionId) this.session = null; resolve({ ok: true }); return;
        case "check": case "observe": {
          const s = this.session;
          if (!s || s.sessionId !== m.sessionId) { refuse("no_session"); return; }
          if (s.surfaceId !== m.surfaceId) { refuse("surface_mismatch"); return; }
          if (this.locked) { refuse("screen_locked"); return; }
          const answer = () => {
            resolve(m.op === "check" ? { ok: true, expiresAt: s.expiresAt }
              : { ok: true, truncated: false, surface: { surfaceId: s.surfaceId, label: "App Secreto" }, nodes: [{ elementId: "el_1", role: "AXButton", title: "Send", value: "", enabled: true }] });
          };
          if (this.holdCheck && m.op === "check") { this.held = answer; return; }
          answer();
          return;
        }
        default: refuse("busy");
      }
    });
  }
  /** The operator approves the open prompt (selects the surface). */
  approve(sessionId = SESSION, seconds = 60): void {
    const p = this.prompt!;
    this.prompt = null;
    this.session = { sessionId, botKey: p.botKey, surfaceId: SURFACE, expiresAt: this.now() + seconds * 1000 };
    this.emit({ event: "session_started", session: { ...this.session, surfaceLabel: "App Secreto", indicatorVisible: true } });
  }
  emit(e: Record<string, unknown>): void { for (const l of [...this.listeners]) l(e); }
  onEvent(l: (e: Record<string, unknown>) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  onExit(l: () => void): void { this.exits.add(l); }
  async close(): Promise<void> { this.kill(); }
  kill(): void { if (!this.alive) return; this.alive = false; for (const l of [...this.exits]) l(); }
}

function lab(t: TestContext, grants: LocalBotGrant[] = [grant("bot_a"), grant("bot_b")], consentPromptSeconds = 60, policyDir: string | null = null) {
  let now = 1_000_000;
  let policy: LocalCapabilityPolicy;
  if (policyDir) {
    writeFileSync(join(policyDir, "policy.json"), JSON.stringify({ version: 1, bots: grants }), { mode: 0o600 });
    policy = LocalCapabilityPolicy.load(join(policyDir, "policy.json"));
  } else policy = new LocalCapabilityPolicy({ version: 1, bots: grants });
  const helpers: Helper[] = [];
  const caps = createLocalCapabilities({ dataDir: temp(t), policy, clock: () => now,
    cua: { transport: () => { const h = new Helper(() => now); helpers.push(h); return h; }, requestTimeoutMs: 2_000, consentPromptSeconds } });
  t.after(() => caps.close());
  const run = (botId: string, tool: string, args: Record<string, JsonValue> = {}) =>
    caps.handlers.get(tool)!(checkOperationArgs(tool, args), { signal: new AbortController().signal, job: job(botId, tool) }) as Promise<Record<string, unknown>>;
  return { policy, caps, run, helper: () => helpers.at(-1)!, helpers, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("status: no session asks the operator once, with policy label and bounds; approval yields the bot's own surface id", async (t) => {
  const l = lab(t);
  const first = await l.run("bot_a", CUA_STATUS);
  assert.deepEqual(first, { state: "consent_pending", promptExpiresAt: l.now() + 60_000 });
  assert.deepEqual(l.helper().requests, [{ op: "request_consent", botKey: keyOf("bot_a"), botLabel: "Rotulo a", maxSeconds: 120, promptSeconds: 60 }]);
  assert.deepEqual(await l.run("bot_a", CUA_STATUS), first, "pending is reported, not asked again");
  assert.equal(l.helper().requests.length, 1);
  l.helper().approve();
  const active = await l.run("bot_a", CUA_STATUS);
  assert.deepEqual(active, { state: "active", session: { sessionId: SESSION, surfaceId: SURFACE, expiresAt: l.now() + 60_000 } });
  assert.deepEqual(l.helper().requests.at(-1), { op: "check", sessionId: SESSION, surfaceId: SURFACE }, "gates re-checked by the helper");
  assert.equal(JSON.stringify(active).includes("App Secreto"), false, "no app label in status");
  // The id the bot learned from status is what observe/control need.
  const seen = await l.run("bot_a", CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 5 });
  assert.equal(seen.trust, "untrusted_external");
  // Another bot learns nothing about bot A's session: its own prompt is refused as busy.
  await assert.rejects(l.run("bot_b", CUA_STATUS), refused("busy"));
  await assert.rejects(l.run("bot_b", CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 5 }), refused("consent_required"));
});

test("status: grant and admission gates come before any helper request", async (t) => {
  const l = lab(t, [grant("bot_a", { operations: [CUA_OBSERVE] }), grant("bot_b", { cuaMaxSessionSeconds: 0 })]);
  await assert.rejects(l.run("bot_a", CUA_STATUS), refused("not_granted"));
  await assert.rejects(l.run("bot_b", CUA_STATUS), refused("not_granted"));
  await assert.rejects(l.run("bot_c", CUA_STATUS), refused("not_granted"));
  await assert.rejects(l.caps.handlers.get(CUA_STATUS)!({}, { signal: new AbortController().signal }), refused("context_missing"));
  assert.equal(l.helpers.length, 0, "no helper was even started");
});

test("status: a grant change withdraws the open prompt and a late approval under the old generation starts nothing", async (t) => {
  const l = lab(t);
  await l.run("bot_a", CUA_STATUS);
  const h = l.helper();
  l.policy.replace({ version: 1, bots: [grant("bot_a", { label: "Novo" }), grant("bot_b")] });
  await tick();
  assert.deepEqual(h.requests.at(-1), { op: "cancel_consent", botKey: keyOf("bot_a") });
  // A helper that still delivers an approval from the old prompt: the session is ended at once.
  h.prompt = { botKey: keyOf("bot_a"), expiresAt: l.now() + 60_000 };
  h.approve();
  await tick();
  assert.deepEqual(h.requests.at(-1), { op: "end_session", sessionId: SESSION, reason: "daemon" });
  assert.equal(l.caps.cua!.status().sessions.length, 0);
  // The next status asks again under the new grant (new label).
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "consent_pending");
  assert.equal(h.requests.at(-1)!.botLabel, "Novo");
});

test("status: a prompt the operator ignored expires; approval after the deadline is ended and closes it; only the owner re-arms", async (t) => {
  const l = lab(t, undefined, 5);
  const first = await l.run("bot_a", CUA_STATUS);
  assert.equal(first.promptExpiresAt, l.now() + 5_000);
  l.advance(5_000 + 2_001);
  const h = l.helper();
  h.approve();
  await tick();
  assert.deepEqual(h.requests.at(-1), { op: "end_session", sessionId: SESSION, reason: "daemon" }, "late approval");
  assert.equal(l.caps.cua!.status().sessions.length, 0);
  assert.equal(l.caps.cua!.status().consentsPending, 0, "the late approval closed the prompt");
  assert.deepEqual(await l.run("bot_a", CUA_STATUS), { state: "consent_expired" }, "reported, not asked again");
  assert.equal(h.requests.filter((r) => r.op === "request_consent").length, 1);
  l.caps.cua!.rearmConsent("bot_a");
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "consent_pending");
  assert.equal(h.requests.filter((r) => r.op === "request_consent").length, 2);
});

test("status: after a denial repeated status/observe calls never prompt again until owner re-arm or a grant change", async (t) => {
  const l = lab(t);
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "consent_pending");
  const h = l.helper();
  const prompts = () => h.requests.filter((r) => r.op === "request_consent").length;
  h.prompt = null;
  h.emit({ event: "consent_denied", botKey: keyOf("bot_a") });
  for (let i = 0; i < 6; i++) assert.deepEqual(await l.run("bot_a", CUA_STATUS), { state: "consent_denied" });
  await assert.rejects(l.run("bot_a", CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 5 }), refused("consent_denied"));
  await assert.rejects(l.run("bot_a", CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "press" }), refused("consent_denied"));
  assert.equal(prompts(), 1, "no renewal on the bot's initiative");
  assert.equal(l.caps.cua!.status().consentsPending, 0);
  // Another bot's re-arm or prompt does not reopen it.
  l.caps.cua!.rearmConsent("bot_b");
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "consent_denied");
  // A change of the bot's local grant (owner intent, new generation) allows one new prompt.
  l.policy.replace({ version: 1, bots: [grant("bot_a", { label: "Rotulo novo" }), grant("bot_b")] });
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "consent_pending");
  assert.equal(prompts(), 2);
  assert.equal(h.requests.filter((r) => r.op === "request_consent").at(-1)!.botLabel, "Rotulo novo");
  h.prompt = null;
  h.emit({ event: "consent_denied", botKey: keyOf("bot_a") });
  assert.deepEqual(await l.run("bot_a", CUA_STATUS), { state: "consent_denied" });
  l.caps.cua!.rearmConsent("bot_a");
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "consent_pending");
  assert.equal(prompts(), 3);
});

test("status: the daemon's clock closes a prompt whose helper never reports the expiry; no new prompt, late approval refused", async (t) => {
  const l = lab(t, undefined, 5);
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "consent_pending");
  const h = l.helper();
  l.advance(5_000);
  // No consent_expired event from the helper: this side's deadline alone decides.
  assert.deepEqual(await l.run("bot_a", CUA_STATUS), { state: "consent_expired" });
  await assert.rejects(l.run("bot_a", CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 5 }), refused("consent_expired"));
  assert.equal(h.requests.filter((r) => r.op === "request_consent").length, 1);
  h.approve();
  await tick();
  assert.equal(l.caps.cua!.status().sessions.length, 0, "an approval of a closed prompt starts nothing");
  assert.deepEqual(h.requests.at(-1), { op: "end_session", sessionId: SESSION, reason: "daemon" });
});

test("status: revocation, lock and expiry after the helper's check release no session metadata", async (t) => {
  const l = lab(t);
  await l.run("bot_a", CUA_STATUS);
  const h = l.helper();
  h.approve();
  // Revoked while the helper checks: refused, no surface id.
  h.holdCheck = true;
  const pending = l.run("bot_a", CUA_STATUS);
  await tick();
  assert.ok(h.held);
  l.policy.revoke("bot_a", CUA_CONTROL);
  h.held!();
  await assert.rejects(pending, refused("revoked"));
  assert.equal(l.caps.cua!.status().sessions.length, 0);
  h.holdCheck = false;
  // Locked: the helper's check refuses and nothing is released.
  await l.run("bot_a", CUA_STATUS);
  h.approve(`cus_${"c".repeat(32)}`);
  h.locked = true;
  await assert.rejects(l.run("bot_a", CUA_STATUS), refused("screen_locked"));
  h.locked = false;
  // Expired by this side's clock: ended and a new prompt is asked instead of reporting the old session.
  l.advance(61_000);
  const after = await l.run("bot_a", CUA_STATUS);
  assert.equal(after.state, "consent_pending");
  assert.ok(h.requests.some((r) => r.op === "end_session" && r.sessionId === `cus_${"c".repeat(32)}`));
});

test("status: fences after each await hold even when the helper answers after an abort or a grant change", async (t) => {
  const l = lab(t);
  // A grant change while the helper is still answering the prompt request: refused as revoked, prompt withdrawn.
  const h0 = await (async () => { await assert.rejects(l.run("bot_b", CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 1 }), refused("consent_required")); return l.helper(); })();
  h0.prompt = null;
  h0.requests.length = 0;
  h0.holdConsent = true;
  const asking = l.run("bot_a", CUA_STATUS);
  await tick();
  l.policy.replace({ version: 1, bots: [grant("bot_a", { label: "Outro" }), grant("bot_b")] });
  h0.held!();
  await assert.rejects(asking, refused("revoked"));
  assert.ok(h0.requests.some((r) => r.op === "cancel_consent" && r.botKey === keyOf("bot_a")));
  h0.holdConsent = false;
  // A helper that ignores the abort and still confirms its check after the revocation: nothing is released.
  await l.run("bot_a", CUA_STATUS);
  h0.approve();
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "active");
  h0.ignoreAbort = true;
  h0.holdCheck = true;
  const pending = l.run("bot_a", CUA_STATUS);
  await tick();
  l.policy.revoke("bot_a", CUA_CONTROL);
  h0.held!();
  await assert.rejects(pending, refused("revoked"));
});

test("status: a failed policy write (quarantine) ends this bot's session and refuses status", async (t) => {
  const dir = temp(t);
  const l = lab(t, undefined, 60, dir);
  await l.run("bot_a", CUA_STATUS);
  l.helper().approve();
  assert.equal((await l.run("bot_a", CUA_STATUS)).state, "active");
  // A revocation of another bot that cannot be written quarantines the whole policy.
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => { l.policy.revoke("bot_b"); }, (e: unknown) => e instanceof PolicyPersistenceError && e.code === "unavailable");
  } finally { chmodSync(dir, 0o700); }
  await tick();
  assert.ok(l.helper().requests.some((r) => r.op === "end_session" && r.sessionId === SESSION));
  assert.equal(l.caps.cua!.status().sessions.length, 0);
  await assert.rejects(l.run("bot_a", CUA_STATUS), refused("policy_quarantined"));
});

// ---- real Swift helper, fixture mode (optional) -------------------------------------------------

const NATIVE_HELPER = process.env.DEXTER_CUA_HELPER;
test("real helper (fixture mode): status acquires the approved surface end to end; silent lock states refuse", { skip: NATIVE_HELPER ? false : "DEXTER_CUA_HELPER not set" }, async (t) => {
  assert.equal(CUA_PROTOCOL_VERSION, 2);
  const dir = temp(t);
  const exe = join(dir, "dexter-cua-helper");
  copyFileSync(NATIVE_HELPER!, exe);
  chmodSync(exe, 0o755);
  const policy = new LocalCapabilityPolicy({ version: 1, bots: [grant("bot_a", { cuaMaxSessionSeconds: 60 })] });
  let helper!: CuaHelperProcess;
  const caps = createLocalCapabilities({ dataDir: dir, policy, cua: { transport: () => { helper = new CuaHelperProcess({ executable: exe, mode: "fixture" }); return helper; }, requestTimeoutMs: 5_000 } });
  t.after(() => caps.close());
  const run = (tool: string, args: Record<string, JsonValue> = {}) =>
    caps.handlers.get(tool)!(checkOperationArgs(tool, args), { signal: new AbortController().signal, job: job("bot_a", tool) }) as Promise<Record<string, unknown>>;
  // The fixture operator is driven through the fixture op only; the bot never reads helper events.
  const fixture = async (command: string) => assert.equal((await helper.request({ op: "fixture", command }, AbortSignal.timeout(5_000))).ok, true);

  // A denial is final for the bot: status keeps reporting it and the helper shows no new prompt.
  assert.equal((await run(CUA_STATUS)).state, "consent_pending");
  await fixture("deny_consent");
  let denied: Record<string, unknown> = {};
  for (const end = Date.now() + 5_000; denied.state !== "consent_denied" && Date.now() < end;) {
    denied = await run(CUA_STATUS);
    if (denied.state !== "consent_denied") await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(denied.state, "consent_denied");
  for (let i = 0; i < 5; i++) assert.equal((await run(CUA_STATUS)).state, "consent_denied");
  // No prompt is open in the helper: approving now has nothing to approve.
  assert.notEqual((await helper.request({ op: "fixture", command: "approve_consent" }, AbortSignal.timeout(5_000))).ok, true);
  caps.cua!.rearmConsent("bot_a");
  assert.equal((await run(CUA_STATUS)).state, "consent_pending");
  await fixture("approve_consent");
  // Waits for the helper's own event to reach the capability (bounded); the bot only ever calls status.
  let status: Record<string, unknown> = {};
  for (const end = Date.now() + 5_000; status.state !== "active" && Date.now() < end;) {
    status = await run(CUA_STATUS);
    if (status.state !== "active") await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(status.state, "active");
  const surfaceId = (status.session as Record<string, string>).surfaceId!;
  assert.match(surfaceId, /^srf_[0-9a-f]{32}$/);
  const seen = await run(CUA_OBSERVE, { surfaceId, maxNodes: 5 });
  const element = (seen.nodes as Array<Record<string, string>>)[0]!.elementId!;
  assert.deepEqual(await run(CUA_CONTROL, { surfaceId, elementId: element, action: "press" }), { performed: true, sessionActive: true });
  // Silent lock (no event): only the helper's polled gate sees it; control is refused before input.
  await fixture("lock_silent");
  await assert.rejects(run(CUA_CONTROL, { surfaceId, elementId: element, action: "press" }), refused("screen_locked"));
  await fixture("unlock");
  // Unknown lock state (the native default until calibrated) refuses even the prompt.
  await fixture("lock_unknown_silent");
  await assert.rejects(run(CUA_STATUS), refused("lock_state_unknown"));
});
