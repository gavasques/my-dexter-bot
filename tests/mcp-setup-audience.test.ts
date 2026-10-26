import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostServices } from "../packages/cli/src/host-services.js";
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from "../packages/cli/src/harness-operation-surface.js";
import type { EngineDriver } from "@dexter/engines";
import type { Bot, Thread } from "@dexter/contracts";

test("Team turns refuse managed setup before admission but retain the legacy exact native OAuth handoff", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dx-setup-audience-")), surfaces: HarnessOperationSurface[] = [];
  const driver = (id: EngineDriver["id"]): EngineDriver => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
    status: async () => ({ engine: id, installed: true, version: "synthetic", authentication: "authenticated", billing: "subscription" }), open: async threadId => ({ threadId, nativeCursor: "synthetic" }),
    async *turn(session, turnId) { yield { type: "turn.completed", threadId: session.threadId, turnId, usage: null }; },
    async respondToTool() {}, async interrupt() {}, async close() {} });
  let OAuthEffects = 0;
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true, makeDriver: driver,
    nativeMcp: { runsOn: "owner_mac", oauth: { fetch: async () => { OAuthEffects++; throw new Error("No real OAuth in audience fixture."); },
      store: { async load() { OAuthEffects++; return null; }, async save() { OAuthEffects++; }, async remove() { OAuthEffects++; } } } } });
  t.after(async () => { for (const surface of surfaces) await surface.close(); await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const store = services.store, bot = store.createBot({ name: "Synthetic Team bot", profileId: "default", engine: "claude" });
  const team = services.teamsHttp.create({ expectedHostID: store.hostId, clientRequestId: randomUUID(), name: "Synthetic Team", coordinatorBotId: bot.id, botIds: [bot.id] });
  const teamThread = store.createThread(bot.id); services.teamsHttp.bindThread(team.id, teamThread.id, team.revision, randomUUID());
  const live = (actor: Bot, thread: Thread) => {
    const turn = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: "Synthetic Team setup." }).turn;
    store.claimNextTurn(thread.id);
    const surface = new HarnessOperationSurface({ store, base: services.gateway!, catalog: services.engineCatalog, runtime: () => services.runtime!,
      skills: () => services.skillsHttp, effectiveSkills: () => [], mcp: () => services.nativeMcpAdmin,
      connections: () => services.connectionWorkflows, connectionCatalog: () => services.connectionsHttp.catalog(), resultArtifacts: () => services.mcpResultArtifacts });
    surfaces.push(surface); return { actor, thread, turn, surface, token: surface.issueCapability({ turnId: turn.id }).token };
  };
  const own = live(bot, teamThread);
  assert.equal(store.isOwnDocumentTurnPrivate(own.turn.id), false, "actual Context Team binding, including an ordinary thread ID");
  assert.ok(!own.surface.listTools(own.token).some(tool => tool.name.startsWith("dexter.harness.connections.")));
  const call = (name: string, callId: string, args: Record<string, unknown> = {}) => own.surface.call(own.token,
    { connectionId: HARNESS_OPERATION_DESTINATION, tool: `dexter.harness.${name}`, callId, arguments: args });
  await assert.rejects(call("connections.request", "refused-before-admission", { request_json: JSON.stringify({ clientRequestId: randomUUID(),
    expectedBotRevision: bot.revision, target: { kind: "managed", serviceId: "gmail", catalogPin: "a".repeat(64) } }) }), (error: { code?: string }) => error.code === "forbidden");
  assert.equal(store.listActions().length, 0); assert.equal(store.connectionWorkflows().length, 0);

  const registration = { schema_version: 1, server_id: "synthetic-oauth", name: "Synthetic OAuth", url: "https://oauth.example.test/mcp", authentication: "oauth" };
  const proposed = await call("mcp.add_http", "register", registration);
  store.decideAction(proposed.actionId, { decision: "allow", requestHash: proposed.requestHash });
  const registered = await call("mcp.add_http", "register", registration); assert.equal(registered.status, "succeeded");
  const args = { server_id: registration.server_id, expected_instance_pin: (registered.result as any).instancePin, action_id: registered.actionId };
  const authorize = await call("mcp.authorize", "authorize", args);
  store.decideAction(authorize.actionId, { decision: "allow", requestHash: authorize.requestHash });
  const handoff = await call("mcp.authorize", "authorize", args);
  assert.equal(handoff.status, "succeeded"); assert.equal((handoff.result as any).kind, "mcp_authorization_handoff");
  assert.equal(store.connectionWorkflows().length, 0, "nonprivate native authorization remains a handoff, never a private workflow");
  assert.equal(store.listActions("unknown").length, 0); assert.equal(OAuthEffects, 0);

  const artifact = services.mcpResultArtifacts.save({ botId: bot.id, threadId: teamThread.id, actionId: registered.actionId,
    requestHash: registered.requestHash, content: { synthetic: "Already sanitized overflow result." } }) as { artifactId: string };
  assert.ok(artifact);
  assert.ok(own.surface.listTools(own.token).some(tool => tool.name === "dexter.harness.results.artifact.read"));
  assert.equal((await call("results.artifact.read", "own-artifact", { artifact_id: artifact.artifactId })).status, "succeeded");
  const privateThread = store.createThread(bot.id), foreign = live(bot, privateThread);
  const count = store.listActions().length;
  for (const name of ["read", "remove"]) await assert.rejects(foreign.surface.call(foreign.token,
    { connectionId: HARNESS_OPERATION_DESTINATION, tool: `dexter.harness.results.artifact.${name}`, callId: `foreign-${name}`, arguments: { artifact_id: artifact.artifactId } }));
  assert.equal(store.listActions().length, count, "the same bot cannot read or admit removal in a different thread");
  const other = store.createBot({ name: "Synthetic other bot", profileId: "default", engine: "claude" }), otherThread = store.createThread(other.id), otherLive = live(other, otherThread);
  await assert.rejects(otherLive.surface.call(otherLive.token,
    { connectionId: HARNESS_OPERATION_DESTINATION, tool: "dexter.harness.results.artifact.read", callId: "foreign-bot", arguments: { artifact_id: artifact.artifactId } }));
  const removal = await call("results.artifact.remove", "remove", { artifact_id: artifact.artifactId }); assert.equal(removal.status, "awaiting_approval");
  store.decideAction(removal.actionId, { decision: "allow", requestHash: removal.requestHash });
  assert.equal((await call("results.artifact.remove", "remove", { artifact_id: artifact.artifactId })).status, "succeeded");
  assert.throws(() => services.mcpResultArtifacts.read(bot.id, teamThread.id, artifact.artifactId));
  for (const row of [own, foreign, otherLive]) store.finishTurn(row.turn.id, "completed", null);
});
