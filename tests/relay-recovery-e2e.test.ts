// G8 relay recovery END-TO-END (Opus author round 2). ONE source HostServices with all eight durable stores LIVE (Hub,
// Context, Agenda, device registry, DeviceTurnSurface, AppClients, relay consumer, relay associations), a SEPARATE
// relay-service process (real CLI parser/lifecycle, memory TLS over IPC), actual owner UDS pairing + pre-cut ACK
// reconciliation, online authority transfer by the `dexter` CLI child, activation, joint eight-store comparison, then the
// destination: recovery mode -> fresh owner pairing -> rotation to the trusted next provider -> explicit enrollment ->
// relay-service restart with the new PUBLIC pins -> normal relay with exactly one new turn. Synthetic keys in memory only.
// Populated recovery (Opus author round 1): the live Context authority tables (teams, members, team_bots, recall_grants,
// promotions, memories) are seeded through pinned historical Hub14/Context3 APIs, migrated to current Hub/Context,
// and transferred through the live current writer. Current private turns refuse team/global memory independently.
// A further restart of the SAME RelayStore lists the old sender in the explicit `revokedDevices` config.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AuthorityCoordinator, LocalAuthorityController, currentOperationCatalog } from "@dexter/operations";
import { StableRelayOpener } from "@dexter/relay-host";
import { ContextError, ContextHost, type ContextScope, type MemoryAdapter, type MemoryPage } from "@dexter/context";
import { SCHEMA_VERSION } from "@dexter/hub";
import type { Envelope } from "@dexter/relay";
import type { RelayTransport } from "@dexter/relay-consumer";
import { RelayTransportError, type PinnedRelayTransport } from "@dexter/relay-service";
import { HostServices } from "../packages/cli/src/host-services.js";
import { maintenanceResultPath, type OwnerMaintenanceResult } from "../packages/cli/src/owner-authority-maintenance.js";
import { ownerControlRequest } from "../packages/cli/src/owner-control-client.js";
import { newCustody, seedDeviceSurface, seedInstallation } from "./authority-fixture.js";
import { memoryTLS } from "./fixtures/online-memory-tls.js";
import { until } from "./fixtures/relay-host-lab.js";
import { code, countingEngine, defer, dexter, lab, pairOverOwner, parse, pinFile, relayCustody, relayService, sender, turnEnvelope, type Json } from "./fixtures/relay-recovery-lab.js";
import { historicalBaseline, type HistoricalSeedHost, type HistoricalSeedContext } from "./fixtures/portable-campaign-assets.mjs";

const FILES = ["dexter.sqlite", "context.sqlite", "agenda.sqlite", "devices.sqlite", "device-tools.sqlite", "app-clients.sqlite", "relay-host/relay-consumer.sqlite", "relay-host/relay-associations.sqlite"];
type Row = Record<string, unknown>;
function tables(p: string): Record<string, Row[]> { const db = new DatabaseSync(p, { readOnly: true }); try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => [String(r.name), db.prepare(`SELECT * FROM "${String(r.name)}"`).all().map(r => ({ ...r }))])); } finally { db.close(); } }
function hubVersion(p: string): number { const db = new DatabaseSync(p, { readOnly: true }); try { return Number(db.prepare("PRAGMA user_version").get()!.user_version); } finally { db.close(); } }
const sorted = (r: Row[]) => r.map(x => JSON.stringify(x)).sort();
function tree(p: string, prefix = ""): Record<string, string> { let out: Record<string, string> = {}; for (const n of readdirSync(p)) { const q = join(p, n), k = prefix + n; if (statSync(q).isDirectory()) out = { ...out, ...tree(q, k + "/") }; else out[k] = readFileSync(q).toString("base64"); } return out; }
const ask = async (socket: string, op: string, args: Json): Promise<Json> => { const out = await ownerControlRequest(socket, { op, args } as never); assert.equal(out.kind, "response"); return (out as { response: Json }).response; };
const memory = { origin: "http://127.0.0.1:1", labLoopbackWithoutAuth: true, fetch: async () => { throw new Error("no ai-memory request in this lab"); } };
function borrowed(get: () => PinnedRelayTransport, control: { failNext: number; acks: number }): RelayTransport {
  return { poll: r => get().poll(r), ack: async r => { control.acks++; if (control.failNext > 0) { control.failNext--; throw new Error("synthetic ACK loss"); } return get().ack(r); }, close: async () => undefined };
}
interface ContextSeed { principal: string; teamActive: string; teamRevoked: string; pages: { bot: MemoryPage; team: MemoryPage; global: MemoryPage; revokedTeam: MemoryPage }; applied: MemoryPage; reversed: MemoryPage; pendingId: string }
/** Synthetic same-owner Context authority through the pinned historical APIs only (no SQL writes, no ai-memory request).
 * Baseline803 already prohibited private bot -> team promotions. Its legitimate bot <-> global promotions exercise
 * applied, reversed and pending legacy states; current scopes never inherit that old global visibility.
 * The running principal is prepared by the store on its own thread (never kicked by the runtime) and is terminal on return. */
function seedContext(store: HistoricalSeedHost, context: HistoricalSeedContext): ContextSeed {
  const page = (scope: ContextScope, markdown: string) => context.createMemory({ scope, locale: "en-US", markdown, origin: "synthetic-recovery-e2e", classification: "context" });
  const principal = store.createBot({ name: "Context principal", profileId: "personal", engine: "claude" }).id;
  const teamActive = context.createTeam("Synthetic same-owner team"), teamRevoked = context.createTeam("Synthetic revoked team");
  const active: ContextScope = { kind: "team", teamId: teamActive };
  context.assignBot(teamActive, principal); context.assignBot(teamRevoked, principal);
  context.setMember(teamActive, store.ownerId, false); context.setMember(teamActive, store.ownerId, true); // active, revision 3
  context.setMember(teamRevoked, store.ownerId, false); // revoked membership, revision 2
  context.setRecallGrant(principal, active, false); context.setRecallGrant(principal, active, true); // allowed, revision 2
  context.setRecallGrant(principal, { kind: "global" }, true); // revoked below, after the global promotion was applied
  const pages = { bot: page({ kind: "bot", botId: principal }, "# Bot page\nsynthetic bot memory"), team: page(active, "# Team page\nsynthetic team memory"),
    global: page({ kind: "global" }, "# Global page\nsynthetic owner-global memory"), revokedTeam: page({ kind: "team", teamId: teamRevoked }, "# Revoked team page\nsynthetic") };
  const thread = store.createThread(principal), turn = store.createTurn(thread.id, { clientRequestId: "context-seed", content: "synthetic context principal" }).turn;
  assert.equal(store.claimNextTurn(thread.id)?.id, turn.id); const token = context.issue(turn.id);
  assert.throws(() => context.proposePromotion(token, pages.bot.id, active), error => error instanceof Error && "code" in error && error.code === "forbidden", "the actual historical API already refused private bot-to-team promotion");
  const toBot = context.proposePromotion(token, pages.global.id, { kind: "bot", botId: principal }), toGlobal = context.proposePromotion(token, pages.bot.id, { kind: "global" });
  const pending = context.proposePromotion(token, pages.bot.id, { kind: "global" });
  const applied = context.approvePromotion(toBot.id, toBot.requestHash), reversed = context.approvePromotion(toGlobal.id, toGlobal.requestHash);
  context.reversePromotion(toGlobal.id); context.revoke(token);
  context.setRecallGrant(principal, { kind: "global" }, false); // revoked grant, revision 2
  assert.equal(store.finishTurn(turn.id, "completed", null).state, "completed", "principal terminal before maintenance");
  return { principal, teamActive, teamRevoked, pages, applied, reversed, pendingId: pending.id };
}

test("source-composed recovery: live eight-store transfer, owner UDS re-pairing, rotation, fresh enrollment, relay restart, one new turn", { timeout: 240_000 }, async t => {
  const p = lab(t, "re-"), data = join(p, "src"), dest = join(p, "dst"), artifact = join(p, "checkpoint"), sock = join(p, "s.sock"), dsock = join(p, "d.sock");
  const historical = await historicalBaseline(), oldStore = new historical.hub.HostStore({ dataDir: data });
  const oldContext = new historical.context.ContextHost(oldStore, new historical.context.FixtureMemoryAdapter([]));
  let ctx: ContextSeed;
  try { ctx = seedContext(oldStore, oldContext); } finally { oldContext.close(); oldStore.close(); }
  const legacyRows = tables(join(data, "context.sqlite"));
  assert.equal(hubVersion(join(data, "dexter.sqlite")), 14, "actual pinned historical Hub writer");
  assert.equal(legacyRows.meta!.find(row => row.key === "schema")!.value, "3", "actual pinned historical Context writer");
  assert.deepEqual(legacyRows.promotions!.map(row => row.state).sort(), ["applied", "pending", "reversed"]);
  const seeded = seedInstallation(data);
  assert.equal(hubVersion(join(data, "dexter.sqlite")), SCHEMA_VERSION, "current Hub upgrades the historical input");
  const upgradedRows = tables(join(data, "context.sqlite"));
  assert.equal(upgradedRows.meta!.find(row => row.key === "schema")!.value, "5", "current Context3 -> Context5 additive migration");
  for (const name of ["teams", "members", "team_bots", "recall_grants", "promotions"]) assert.deepEqual(sorted(upgradedRows[name]!), sorted(legacyRows[name]!), `${name}: historical rows survive migration`);
  for (const page of legacyRows.memories!) assert.deepEqual(upgradedRows.memories!.find(row => row.id === page.id), page, "historical memory row survives migration");
  // The seed's synthetic association rows are not live-openable; the LIVE relay below creates and populates real metadata.
  rmSync(join(data, "relay-host", "relay-associations.sqlite"));
  const surface = await seedDeviceSurface(data, seeded);
  const ops = newCustody();
  const coordinator = AuthorityCoordinator.open(join(p, "coord"), { ownerId: seeded.ownerId, ownerPublicKey: ops.owner.publicKey }); defer(t, () => coordinator.close());
  const ids = { hostId: seeded.hostId, ownerId: seeded.ownerId }, c1 = relayCustody(ids, 1), c2 = relayCustody(ids, 2), serviceTLS = memoryTLS();
  let net: PinnedRelayTransport | undefined; const src = { failNext: 0, acks: 0 }, engine = countingEngine();
  const source = new HostServices({ dataDir: data, enableEngines: true, enableMcp: true, enableDeviceTools: true, enableAgenda: true, makeDriver: engine.makeDriver,
    devices: { identity: memoryTLS(), pollWaitMs: 50, receiptTimeoutMs: 1000 }, context: { ownerExclusiveDeployment: true, memory },
    appClients: { identity: memoryTLS() }, ownerControl: { socketPath: sock }, authorityMaintenance: { coordinator, custody: ops.provider, graceMs: 5000 },
    relay: { recipient: c1.pin, custody: c1.provider, custodyMode: "laboratory-memory", transport: borrowed(() => net!, src), transportOwnership: "borrowed", deployment: { maximumPendingPerRecipient: 64 } } });
  let sourceClosed = false; defer(t, async () => { if (!sourceClosed) await source.shutdown({ graceMs: 2000 }).catch(() => undefined); });
  await source.startOwnerControl();
  // Actual owner flow: fresh offer -> memory mTLS claim -> approval; public enrollment through the existing owner op.
  const p1 = await pairOverOwner(sock, memoryTLS()), s1 = sender(ids, p1.deviceId, 1);
  const binding = (await ask(sock, "relay.binding", { deviceId: p1.deviceId })).result.binding;
  assert.equal((await ask(sock, "relay.enroll", { expectedRevision: null, expectedHostRevision: 1, deviceId: p1.deviceId, bindingRevision: binding.revision, senderPin: s1.publicPin })).result.grantsCreated, 0);
  let svc = await relayService(t, p, "svc1", serviceTLS, { dataDir: join(p, "relay-svc"), ownerId: ids.ownerId, installationId: ids.hostId, pins: [c1.pin, s1.publicPin] });
  net = svc.transport(); const producer = svc.transport(); defer(t, () => producer.close());
  const bot = source.store.createBot({ name: "Relay e2e", profileId: "personal", engine: "claude" }), thread = source.store.createThread(bot.id);
  let seq = 0; const sent = new Map<string, Envelope>(); const send = (op: string) => { const e = turnEnvelope(s1, c1.pin, ++seq, op, thread.id); sent.set(op, e); return producer.enqueue(e); };
  await send("op_a"); assert.equal((await source.wakeRelay()).acked, 1);
  const b = await send("op_b"); src.failNext = 1; assert.equal((await source.wakeRelay()).unknown, 1);
  // The relay redelivers unACKed B (at-least-once): it is replayed against its canonical turn, never re-run.
  const c = await send("op_c"); src.failNext = 2; const third = await source.wakeRelay();
  assert.deepEqual({ delivered: third.delivered, accepted: third.accepted, replayed: third.replayed, unknown: third.unknown }, { delivered: 2, accepted: 1, replayed: 1, unknown: 2 });
  // The current host also resumes the seeded device receipt's response, without re-executing its effect.
  // Count this actual canonical continuation separately from the three exactly-once relay turns.
  const receiptResponse = () => source.store.toolActionProgress(surface.okActionId)?.responseTurnId;
  await until(() => { const responseId = receiptResponse(); return engine.turns === 4
    && source.store.listTurns(thread.id).every(turn => turn.state === "completed")
    && typeof responseId === "string" && source.store.getTurn(responseId).state === "completed"; });
  const responseId = receiptResponse(); assert.ok(responseId);
  assert.equal(source.store.getTurn(responseId).threadId, surface.surfaceThreadId);
  assert.deepEqual(engine.turnReceipts.map(receipt => receipt.turnId).sort(),
    [...source.store.listTurns(thread.id).map(turn => turn.id), responseId].sort(), "only the three relay turns and the seeded receipt response execute, each once");
  assert.equal(source.store.getAction(surface.okActionId).state, "succeeded");
  assert.equal(source.store.getAction(surface.unknownActionId).state, "unknown", "receipt response never repeats an unknown effect");
  // Pre-cut reconciliation by the operator CLI (separate process): list, then ONE explicit ACK of B; C stays unresolved.
  const listed = await dexter(["relay", "acks", "--owner-control-socket", sock]); assert.equal(listed.code, 0, listed.stderr);
  const rows = parse(listed.stdout); const rb = rows.items.find((i: Json) => i.receiptId === b.receiptId), rc = rows.items.find((i: Json) => i.receiptId === c.receiptId);
  assert.deepEqual({ pending: rows.pending, b: rb.disposition, c: rc.disposition, synthetic: rows.items.filter((i: Json) => i.disposition === "provenance_unverifiable").length }, { pending: 5, b: "reconcilable", c: "reconcilable", synthetic: 3 });
  const reconciled = await dexter(["relay", "ack-reconcile", "--owner-control-socket", sock, "--device", rb.deviceId, "--operation", rb.operationId, "--message", rb.messageId, "--receipt", rb.receiptId, "--issuer-hash", rb.issuerHash]);
  assert.equal(reconciled.code, 0, reconciled.stderr); assert.equal(parse(reconciled.stdout).status, "acked");
  assert.equal(engine.turns, 4, "reconciliation never starts or replays a turn");
  // Historical metadata remains backed up, but its old grants cannot grant current private turns team/global access.
  const refusalThread = source.store.createThread(ctx.principal), refusalTurn = source.store.createTurn(refusalThread.id, { clientRequestId: "current-promotion-refusal", content: "synthetic current policy check" }).turn;
  assert.equal(source.store.claimNextTurn(refusalThread.id)?.id, refusalTurn.id);
  const refusalToken = source.context!.issue(refusalTurn.id), currentPromotions = tables(join(data, "context.sqlite")).promotions!;
  for (const target of [{ kind: "global" } as const, { kind: "team", teamId: ctx.teamActive } as const])
    assert.throws(() => source.context!.proposePromotion(refusalToken, ctx.pages.bot.id, target), error => error instanceof ContextError && error.code === "forbidden", "legacy grants do not broaden current private promotion scopes");
  source.context!.revoke(refusalToken); source.store.finishTurn(refusalTurn.id, "completed", null);
  assert.deepEqual(sorted(tables(join(data, "context.sqlite")).promotions!), sorted(currentPromotions), "denied current requests create no promotion rows");
  // Online transfer: CLI child -> owner UDS ACK leaves drain -> actual quiesce of the eight LIVE stores -> capture -> revoke.
  const moved = await dexter(["authority", "transfer", "--owner-control-socket", sock, "--artifact", artifact, "--destination", dest, "--request-id", "relay-e2e"]);
  assert.equal(moved.code, 0, moved.stderr); const out = parse(moved.stdout); assert.equal(out.status, "source_revoked");
  assert.deepEqual(out.relayPendingAcks, { pending: 4, reconcilable: 0, requires_custody: 1, obsolete_recipient_generation: 0, effect_unconfirmed: 0, proof_missing: 0, provenance_unverifiable: 3 },
    "pre-cut report after the actual drain: C needs the (now closed) gen1 custody; nothing was ACKed by the job");
  sourceClosed = true; assert.equal(c1.closes, 1, "drain closed the owned source custody once");
  const terminal = JSON.parse(readFileSync(maintenanceResultPath(artifact), "utf8")) as OwnerMaintenanceResult; assert.ok(terminal.receipt);
  const before = Object.fromEntries(FILES.map(f => [f, tables(join(data, f))])), repo = tree(join(data, "context-revisions"));
  const ctxRows = before["context.sqlite"]!;
  assert.deepEqual(Object.fromEntries(["teams", "members", "team_bots", "recall_grants", "promotions", "memories"].map(k => [k, ctxRows[k]!.length])),
    { teams: 2, members: 2, team_bots: 2, recall_grants: 2, promotions: 3, memories: 7 }, "Context authority tables are populated, not empty (memories: 6 seeded here + 1 installation seed)");
  assert.deepEqual(ctxRows.members!.map(r => [r.active, r.revision]).sort(), [[0, 2], [1, 3]], "active and revoked memberships, revisions > 1");
  assert.deepEqual(ctxRows.recall_grants!.map(r => [String(r.scope_key).split(":")[0], r.allowed, r.revision]).sort(), [["global", 0, 2], ["team", 1, 2]], "active and revoked grants, revisions > 1");
  assert.deepEqual(ctxRows.promotions!.map(r => r.state).sort(), ["applied", "pending", "reversed"]);
  assert.deepEqual(ctxRows.memories!.map(r => r.active).sort(), [0, 1, 1, 1, 1, 1, 1], "one inactive (reversed) page");
  const activated = new LocalAuthorityController({ coordinator }).activate({ artifact, key: ops.key, receipt: terminal.receipt, operationCatalog: currentOperationCatalog() });
  assert.equal(activated.epoch, 2); assert.equal(activated.coverage.deviceSurface, "included");
  const after = Object.fromEntries(FILES.map(f => [f, tables(join(dest, f))]));
  t.diagnostic(JSON.stringify({ jointEightLiveStoreRows: Object.fromEntries(FILES.map(f => [f, Object.fromEntries(Object.entries(before[f]!).map(([k, v]) => [k, v.length]))])) }));
  for (const f of FILES) {
    assert.deepEqual(Object.keys(after[f]!), Object.keys(before[f]!)); assert.ok(Object.values(before[f]!).some(r => r.length > 0), `${f} populated`);
    for (const table of Object.keys(before[f]!)) {
      const srcRows = before[f]![table]!, dst = after[f]![table]!, expected = srcRows.map(r => ({ ...r }));
      if (f === "dexter.sqlite" && table === "host_lease") { assert.deepEqual(dst, []); continue; }
      if (f === "dexter.sqlite" && table === "host_authority") { const d = dst[0]!, r = expected[0]!; assert.equal(dst.length, 1);
        for (const k of ["epoch", "state", "directory", "directory_ino", "provenance", "checkpoint_id", "revoked_artifact", "revoked_target", "updated_at", "activation_receipt"]) { assert.ok(k in r); r[k] = d[k]; }
        assert.deepEqual([d.epoch, d.state, d.directory, d.provenance], [2, "active", dest, "activation"]); }
      if (f === "dexter.sqlite" && table === "devices") for (const r of expected) { const d = dst.find(x => x.id === r.id)!; assert.ok(d.revoked_at !== null); r.revoked_at = d.revoked_at; }
      if (f === "dexter.sqlite" && table === "thread_sessions") for (const r of expected) { const d = dst.find(x => x.thread_id === r.thread_id)!; assert.equal(d.native_cursor, null); if (r.native_cursor !== null) { r.native_cursor = null; r.updated_at = d.updated_at; } }
      if (f === "dexter.sqlite" && table === "actions") for (const r of expected) { if (["ready", "awaiting_approval"].includes(String(r.state)) && before[f]!.devices!.some(d => d.id === r.destination && d.revoked_at === null)) { const d = dst.find(x => x.id === r.id)!; assert.equal(d.state, "blocked"); r.state = "blocked"; r.reason = "permission_changed"; r.updated_at = d.updated_at; } }
      if (f === "dexter.sqlite" && table === "events") { const extras = dst.filter(r => !sorted(srcRows).includes(JSON.stringify(r))); const active = before[f]!.devices!.filter(d => d.revoked_at === null).map(d => d.id);
        const blocked = before[f]!.actions!.filter(a => ["ready", "awaiting_approval"].includes(String(a.state)) && active.includes(a.destination));
        assert.equal(extras.length, active.length + blocked.length); assert.deepEqual(extras.filter(e => e.kind === "device.revoked").map(e => e.entity_id).sort(), [...active].sort()); expected.push(...extras); }
      if (["devices.sqlite", "app-clients.sqlite"].includes(f) && table === "offers") for (const r of expected) if (r.status === "open") { const d = dst.find(x => x.id === r.id)!; assert.equal(d.status, "cancelled"); r.status = "cancelled"; r.updated_at = d.updated_at; }
      if (["devices.sqlite", "app-clients.sqlite"].includes(f) && table === "claims") for (const r of expected) if (r.status === "pending" || r.status === "approving") { const d = dst.find(x => x.id === r.id)!; const s = r.status === "pending" ? "rejected" : "failed"; assert.equal(d.status, s); r.status = s; r.decided_at = d.decided_at; }
      assert.deepEqual(sorted(dst), sorted(expected), `${f}:${table} exact with explicit closed effects`);
    }
  }
  const covered = (n: string) => !n.startsWith(".git/") || n === ".git/HEAD" || n === ".git/refs/heads/master" || /^\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(n);
  const actualTree = tree(join(dest, "context-revisions"));
  assert.deepEqual(Object.fromEntries(Object.entries(actualTree).filter(([n]) => covered(n))), Object.fromEntries(Object.entries(repo).filter(([n]) => covered(n))));
  const grantsAfterActivation = after["dexter.sqlite"]!.grants!.length;

  // Destination: the normal relay with a NEW unapproved provider is refused before any write; writer released.
  const destAssoc = tables(join(dest, FILES[7]!)), destConsumer = tables(join(dest, FILES[6]!));
  assert.throws(() => new HostServices({ dataDir: dest, enableEngines: true, appClients: { identity: memoryTLS() },
    relay: { recipient: c2.pin, custody: c2.provider, custodyMode: "laboratory-memory", transport: borrowed(() => net!, src), transportOwnership: "borrowed", deployment: { maximumPendingPerRecipient: 64 } } }), code("conflict"));
  assert.deepEqual(tables(join(dest, FILES[7]!)), destAssoc); assert.deepEqual(tables(join(dest, FILES[6]!)), destConsumer); assert.equal(c2.closes + Number(c2.signStarted), 0);
  // Recovery mode: owner pairing works WITHOUT the normal relay; rotation needs the trusted next provider; enrollment is explicit.
  const destTLS = memoryTLS(), engine2 = countingEngine();
  const recovery = new HostServices({ dataDir: dest, enableEngines: true, makeDriver: engine2.makeDriver, appClients: { identity: destTLS }, ownerControl: { socketPath: dsock },
    relayRecovery: { nextRecipient: { custody: c2.provider, custodyMode: "laboratory-memory" } } });
  let recoveryClosed = false; defer(t, async () => { if (!recoveryClosed) await recovery.shutdown({ graceMs: 2000 }).catch(() => undefined); });
  await recovery.startOwnerControl();
  const st = parse((await dexter(["relay", "recovery", "status", "--owner-control-socket", dsock])).stdout);
  assert.deepEqual({ gen: st.recipient.generation, rev: st.hostRevision, active: st.active, next: st.nextRecipient.generation, acks: st.acks },
    { gen: 1, rev: 1, active: 1, next: 2, acks: { pending: 4, reconcilable: 0, requires_custody: 1, obsolete_recipient_generation: 0, effect_unconfirmed: 0, proof_missing: 0, provenance_unverifiable: 3 } });
  const p2 = await pairOverOwner(dsock, memoryTLS()), s2 = sender(ids, p2.deviceId, 1);
  assert.notEqual(p2.deviceId, p1.deviceId);
  const rotated = await dexter(["relay", "recovery", "rotate", "--owner-control-socket", dsock, "--pin-file", pinFile(p, "c2.json", c2.pin), "--expected-host-revision", "1"]);
  assert.equal(rotated.code, 0, rotated.stderr); assert.equal(parse(rotated.stdout).tombstoned, 1);
  const oldPeer = parse((await dexter(["relay", "recovery", "peer", p1.deviceId, "--owner-control-socket", dsock])).stdout);
  assert.deepEqual([oldPeer.association.status, oldPeer.binding.status], ["revoked", "revoked"]);
  const oldEnroll = await dexter(["relay", "recovery", "enroll", p1.deviceId, "--owner-control-socket", dsock, "--sender-pin-file", pinFile(p, "s1g2.json", sender(ids, p1.deviceId, 2).publicPin), "--expected-revision", String(oldPeer.association.revision), "--expected-host-revision", "2", "--binding-revision", String(oldPeer.binding.revision)]);
  assert.equal(oldEnroll.code, 1); assert.deepEqual(parse(oldEnroll.stderr), { error: "forbidden", effect: "none" }, "restored peer is never revived");
  const fresh = parse((await dexter(["relay", "recovery", "peer", p2.deviceId, "--owner-control-socket", dsock])).stdout);
  assert.equal(fresh.association, null);
  const enrolled = await dexter(["relay", "recovery", "enroll", p2.deviceId, "--owner-control-socket", dsock, "--sender-pin-file", pinFile(p, "s2.json", s2.publicPin), "--expected-revision", "none", "--expected-host-revision", "2", "--binding-revision", String(fresh.binding.revision)]);
  assert.equal(enrolled.code, 0, enrolled.stderr); assert.equal(parse(enrolled.stdout).revision, 1);
  const st2 = parse((await dexter(["relay", "recovery", "status", "--owner-control-socket", dsock])).stdout);
  assert.deepEqual({ gen: st2.recipient.generation, active: st2.active, obsolete: st2.acks.obsolete_recipient_generation, custody: st2.acks.requires_custody }, { gen: 2, active: 1, obsolete: 1, custody: 0 });
  await recovery.shutdown({ graceMs: 2000 }); recoveryClosed = true;
  assert.equal(engine2.opens + engine2.turns, 0, "no engine kick in recovery"); assert.equal(c2.closes + Number(c2.signStarted) + Number(c2.decryptStarted), 0, "recovery never used the next provider");

  // Owner of the relay service: restart the SAME RelayStore with the newly approved PUBLIC pins (config + process).
  net.close(); await producer.close();
  const stopped = await svc.stop(); assert.equal(stopped.code, 0); assert.deepEqual(stopped.events, ["listening", "closed"]);
  svc = await relayService(t, p, "svc2", serviceTLS, { dataDir: join(p, "relay-svc"), ownerId: ids.ownerId, installationId: ids.hostId, pins: [c2.pin, s2.publicPin] });
  net = svc.transport(); const producer2 = svc.transport(); defer(t, () => producer2.close()); defer(t, () => net?.close());
  const rejected = (e: unknown) => e instanceof RelayTransportError && e.code === "forbidden";
  const old = new StableRelayOpener(c1.freshProvider(), () => undefined);
  await assert.rejects(net.poll(await old.poll({ requestId: randomUUID(), issuedAt: Date.now(), after: 0, limit: 10 })), rejected, "old recipient generation cannot poll");
  const current = new StableRelayOpener(c2.freshProvider(), () => undefined);
  await assert.rejects(net.ack(await current.ack({ requestId: randomUUID(), issuedAt: Date.now(), messages: [{ messageId: rc.messageId, receiptId: c.receiptId }] })), rejected, "old receipt cannot be ACKed by the new generation");
  const destEngine = countingEngine();
  const normal = new HostServices({ dataDir: dest, enableEngines: true, makeDriver: destEngine.makeDriver, appClients: { identity: destTLS },
    relay: { recipient: c2.pin, custody: c2.provider, custodyMode: "laboratory-memory", transport: borrowed(() => net!, { failNext: 0, acks: 0 }), transportOwnership: "borrowed", deployment: { maximumPendingPerRecipient: 64 } } });
  let normalClosed = false; defer(t, async () => { if (!normalClosed) await normal.shutdown({ graceMs: 2000 }).catch(() => undefined); });
  const destBot = normal.store.createBot({ name: "Relay destination", profileId: "personal", engine: "claude" }), destThread = normal.store.createThread(destBot.id);
  await producer2.enqueue(turnEnvelope(s2, c2.pin, 1, "op_new", destThread.id));
  const oldSenderEnvelope = turnEnvelope(s1, c2.pin, 1, "op_oldsender", destThread.id); await producer2.enqueue(oldSenderEnvelope);
  const woke = await normal.wakeRelay();
  assert.deepEqual({ delivered: woke.delivered, accepted: woke.accepted, blocked: woke.blocked, acked: woke.acked }, { delivered: 2, accepted: 1, blocked: 1, acked: 1 }, "old sender denied by the tombstoned association");
  await until(() => destEngine.turns === 1 && normal.store.listTurns(destThread.id).every(turn => turn.state === "completed"));
  assert.equal(normal.store.getTurn(seeded.queuedTurnId).state, "queued"); assert.equal(normal.store.getAction(surface.unknownActionId).state, "unknown");
  assert.equal(normal.store.listTurns(thread.id).length, 3, "restored relay turns are not replayed");
  assert.equal(destEngine.turns, 1); assert.equal(destEngine.opens, 1); assert.equal(engine2.turns, 0);

  // Restored Context read back through a real ContextHost on the destination writer. The index returns EVERY restored row
  // (inactive and out-of-scope included), so scope and activity are enforced by ContextHost alone; markdown is Git-verified.
  const restored = after["context.sqlite"]!.memories!, requested: string[][] = [];
  const index: MemoryAdapter = { implementation: "fixture", targetVersion: "2.5.2", search: async r => { requested.push(r.scopes.map(s => `${s.workspace}/${s.project}`).sort());
    return restored.map(m => ({ workspace: String(m.workspace), project: String(m.project), path: `notes/${String(m.id)}.md` })); } };
  const readBack = new ContextHost(normal.store, index); const where = (pg: MemoryPage) => `${pg.service.workspace}/${pg.service.project}`;
  try {
    const ctxThread = normal.store.createThread(ctx.principal), ctxTurn = normal.store.createTurn(ctxThread.id, { clientRequestId: "context-readback", content: "synthetic restored principal" }).turn;
    assert.equal(normal.store.claimNextTurn(ctxThread.id)?.id, ctxTurn.id); const token = readBack.issue(ctxTurn.id);
    const recalled = await readBack.recall(token, { query: "synthetic", locale: "en-US" });
    readBack.revoke(token); assert.equal(normal.store.finishTurn(ctxTurn.id, "completed", null).state, "completed");
    assert.deepEqual(requested, [[where(ctx.pages.bot)]], "current private recall excludes every team/global scope even when legacy metadata remains");
    assert.deepEqual(recalled.map(pg => pg.id).sort(), [ctx.pages.bot.id, ctx.applied.id].sort(), "only private bot pages and its historically approved bot promotion are readable");
    const sourcePages = [ctx.pages.bot, ctx.pages.team, ctx.pages.global, ctx.pages.revokedTeam, ctx.applied];
    const activeRestored = readBack.activeMemoryPagesForSync();
    assert.deepEqual(activeRestored.map(pg => pg.id).sort(), ctxRows.memories!.filter(r => r.active === 1).map(r => String(r.id)).sort(), "exactly the source's active pages");
    for (const pg of sourcePages) assert.deepEqual(activeRestored.find(x => x.id === pg.id), pg, "active restored page byte-identical (Git-verified read)");
    for (const pg of recalled) assert.deepEqual(pg, sourcePages.find(x => x.id === pg.id));
    assert.deepEqual(readBack.activeMemoryPagesForSync({ ids: [ctx.reversed.id] }), [], "reversed promotion stays inactive");
    assert.throws(() => readBack.approvePromotion(ctx.pendingId, "0".repeat(64)), (e: unknown) => (e as { code?: unknown }).code === "conflict", "pending promotion keeps its request hash binding");
  } finally { readBack.close(); }

  // Explicit operator revocation of the OLD sender: restart the SAME RelayStore (separate process) with the same current pins.
  const control = await producer2.poll(s1.poll({ requestId: randomUUID(), issuedAt: Date.now(), after: 0, limit: 1 }));
  assert.deepEqual(control.deliveries, [], "control: before the explicit revocation the old sender is still an authenticated pin");
  const relayDb = join(p, "relay-svc", "relay.sqlite"), oldReceipts = () => { const db = new DatabaseSync(relayDb, { readOnly: true });
    try { return Object.fromEntries(db.prepare("SELECT message_id, state FROM receipts WHERE sender = ? ORDER BY message_id").all(p1.deviceId).map(r => [String(r.message_id), String(r.state)])); } finally { db.close(); } };
  net.close(); await producer2.close();
  const stopped2 = await svc.stop(); assert.equal(stopped2.code, 0); assert.deepEqual(stopped2.events, ["listening", "closed"]);
  assert.deepEqual(oldReceipts(), { msg_op_a: "acked", msg_op_b: "acked", msg_op_c: "stale", msg_op_oldsender: "pending" }, "before the list: old sender's undelivered receipt is still pending");
  svc = await relayService(t, p, "svc3", serviceTLS, { dataDir: join(p, "relay-svc"), ownerId: ids.ownerId, installationId: ids.hostId, pins: [c2.pin, s2.publicPin], revokedDevices: [p1.deviceId] });
  net = svc.transport(); const producer3 = svc.transport(); defer(t, () => producer3.close());
  await assert.rejects(producer3.enqueue(turnEnvelope(s1, c2.pin, 2, "op_oldsender_new", destThread.id)), rejected, "old sender NEW enqueue refused at remote ingress");
  await assert.rejects(producer3.enqueue(oldSenderEnvelope), rejected, "duplicate replay of the old sender's envelope refused");
  await assert.rejects(producer3.enqueue(sent.get("op_c")!), rejected, "replay of the pre-transfer unknown envelope refused");
  await assert.rejects(producer3.poll(s1.poll({ requestId: randomUUID(), issuedAt: Date.now(), after: 0, limit: 1 })), rejected, "old sender poll refused");
  await assert.rejects(producer3.ack(s1.ack({ requestId: randomUUID(), issuedAt: Date.now(), messages: [{ messageId: oldSenderEnvelope.messageId, receiptId: randomUUID() }] })), rejected, "old sender ACK refused");
  await producer3.enqueue(turnEnvelope(s2, c2.pin, 2, "op_new2", destThread.id));
  const woke3 = await normal.wakeRelay();
  assert.deepEqual({ delivered: woke3.delivered, accepted: woke3.accepted, blocked: woke3.blocked, acked: woke3.acked }, { delivered: 1, accepted: 1, blocked: 0, acked: 1 }, "stale old receipts are undeliverable; the current sender yields one turn");
  await until(() => destEngine.turns === 2 && normal.store.listTurns(destThread.id).every(turn => turn.state === "completed"));
  assert.equal(normal.store.listTurns(destThread.id).length, 2); assert.equal(normal.store.listTurns(thread.id).length, 3, "unknown prior effects never repeated");
  assert.equal(normal.store.getTurn(seeded.queuedTurnId).state, "queued"); assert.equal(normal.store.getAction(surface.unknownActionId).state, "unknown");
  await normal.shutdown({ graceMs: 2000 }); normalClosed = true;
  assert.equal(destEngine.turns, 2); assert.equal(engine2.turns, 0);
  assert.equal(tables(join(dest, "dexter.sqlite")).grants!.length, grantsAfterActivation, "no grant restored or created");
  assert.equal(c2.closes, 1); assert.equal(existsSync(join(dest, "relay-host", "relay-associations.sqlite")), true);
  const finalStop = await svc.stop(); assert.equal(finalStop.code, 0);
  assert.deepEqual(oldReceipts(), { msg_op_a: "acked", msg_op_b: "acked", msg_op_c: "stale", msg_op_oldsender: "stale" }, "the list made the pending old receipt stale");
  const pins = new DatabaseSync(relayDb, { readOnly: true }); try {
    assert.deepEqual(pins.prepare("SELECT device, generation, revoked FROM pins ORDER BY device").all().map(r => [r.device, r.generation, r.revoked]).sort(),
      [[p1.deviceId, 1, 1], [p2.deviceId, 1, 0], ["relay_host", 2, 0]].sort(), "only the listed ID is revoked; current recipient and new sender stay active");
  } finally { pins.close(); }
});
