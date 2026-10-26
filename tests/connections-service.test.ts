import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ConnectorError } from "../packages/connectors/src/errors.js";
import { ComposioConnectClient, composioWriteOutcome, projectComposioAccount } from "../packages/connectors/src/composio-connect.js";
import type { FetchLike } from "../packages/connectors/src/http.js";
import { CONNECTIONS_PLATFORM_INSTALLATION_HEADER } from "@dexter/contracts";
import { ACCESS_TOKEN, COMPOSIO_KEY, LINK_ORIGIN, REFRESH_TOKEN, SERVICE_ORIGIN, VERSION, serviceLab, type ServiceLab } from "./fixtures/connections-lab.js";

// Synthetic only: fake Composio REST v3.1 on loopback, no real provider/account/key/login.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const code = (name: string, status?: number) => (e: unknown) => e instanceof ConnectorError && e.code === name && (status === undefined || e.status === status);
function client(fetch: FetchLike) { return new ComposioConnectClient({ fetch, apiKey: () => COMPOSIO_KEY, authorizationOrigins: [LINK_ORIGIN] }); }
async function call(lab: ServiceLab, capability: string | null, installation: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (capability !== null) headers.authorization = `Bearer ${capability}`;
  if (installation !== null) headers[CONNECTIONS_PLATFORM_INSTALLATION_HEADER] = installation;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(lab.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}
const P1 = { installationId: "inst_alpha", ownerId: "owner_alpha" }, P2 = { installationId: "inst_beta", ownerId: "owner_beta" };

test("Composio client: documented link request, allowlisted redirect, one request, projected account without credentials", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  let reply: Response = json({ link_token: "lk_1", redirect_url: `${LINK_ORIGIN}/link/lk_1`, expires_at: "2026-10-13T03:00:00.000Z", connected_account_id: "ca_1" }, 201);
  const c = client(async (url, init) => { sent.push({ url, init }); return reply; });
  const link = await c.createLink({ authConfigId: "ac_1", userId: "dx:i:o:default", callbackUrl: "https://connections.dexter.test/v1/callback/att?state=n", alias: "dx-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://backend.composio.dev/api/v3.1/connected_accounts/link");
  assert.equal((sent[0]!.init.headers as Record<string, string>)["x-api-key"], COMPOSIO_KEY);
  assert.deepEqual(JSON.parse(sent[0]!.init.body as string), { auth_config_id: "ac_1", user_id: "dx:i:o:default", callback_url: "https://connections.dexter.test/v1/callback/att?state=n", alias: "dx-1" });
  assert.deepEqual(link, { redirectUrl: `${LINK_ORIGIN}/link/lk_1`, expiresAt: Date.parse("2026-10-13T03:00:00.000Z"), connectedAccountId: "ca_1" });
  reply = json({ link_token: "lk_2", redirect_url: "https://evil.example/link/lk_2", expires_at: "2026-10-13T03:00:00.000Z", connected_account_id: "ca_2" }, 201);
  await assert.rejects(c.createLink({ authConfigId: "ac_1", userId: "dx:i:o:default", callbackUrl: "https://connections.dexter.test/cb", alias: "dx-2" }), code("response_invalid"));
  await assert.rejects(c.createLink({ authConfigId: "ac_1", userId: "dx:i:o:default", callbackUrl: "http://insecure.example/cb", alias: "dx-3" }), code("arguments_refused"));
  assert.equal(sent.length, 2, "refused input never reaches the network");
  const raw = { toolkit: { slug: "gmail" }, auth_config: { id: "ac_1", auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false }, id: "ca_1", status: "ACTIVE",
    is_disabled: false, alias: "dx-1", word_id: "gmail_red", user_id: "dx:i:o:default", state: { authScheme: "OAUTH2", val: { displayName: "Ana", access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN } },
    data: { access_token: ACCESS_TOKEN }, params: { secret: REFRESH_TOKEN } };
  const projected = projectComposioAccount(raw);
  assert.deepEqual(projected, { id: "ca_1", toolkit: "gmail", authConfigId: "ac_1", status: "ACTIVE", disabled: false, alias: "dx-1", displayName: "Ana" });
  assert.ok(!JSON.stringify(projected).includes(ACCESS_TOKEN) && !JSON.stringify(projected).includes(REFRESH_TOKEN));
  assert.equal(projectComposioAccount({ ...raw, state: { val: { displayName: "bad\u0007label" } } }).displayName, null);
  assert.throws(() => projectComposioAccount({ ...raw, status: "CONNECTED" }), code("response_invalid"));
});

test("Composio client: write outcomes, 404 reads, refused meta tools/principal arguments before any byte", async () => {
  assert.equal(composioWriteOutcome(new ConnectorError("upstream_status", 422)), "not_applied");
  assert.equal(composioWriteOutcome(new ConnectorError("upstream_status", 429)), "not_applied");
  assert.equal(composioWriteOutcome(new ConnectorError("upstream_status", 500)), "unknown");
  assert.equal(composioWriteOutcome(new ConnectorError("upstream_status", 408)), "unknown");
  assert.equal(composioWriteOutcome(new ConnectorError("timeout")), "unknown");
  assert.equal(composioWriteOutcome(new ConnectorError("response_invalid", 200)), "unknown");
  assert.equal(composioWriteOutcome(new Error("x")), "unknown");
  let calls = 0;
  const c = client(async () => { calls++; return json({ error: { message: "x" } }, 404); });
  assert.equal(await c.getAccount("ca_gone"), null);
  assert.equal(await c.deleteAccount("ca_gone"), null);
  await assert.rejects(c.execute({ slug: "COMPOSIO_SEARCH_TOOLS", version: VERSION, userId: "dx:i:o:p", accountId: "ca_1", arguments: {} }), code("tool_not_allowed"));
  await assert.rejects(c.execute({ slug: "GMAIL_SEND_EMAIL", version: "latest", userId: "dx:i:o:p", accountId: "ca_1", arguments: {} }), code("arguments_refused"));
  await assert.rejects(c.execute({ slug: "GMAIL_SEND_EMAIL", version: VERSION, userId: "dx:i:o:p", accountId: "ca_1", arguments: { connected_account_id: "ca_other" } }), code("arguments_refused"));
  assert.equal(calls, 2);
  const missing = new ComposioConnectClient({ fetch: async () => { calls++; return json({}); }, apiKey: () => "", authorizationOrigins: [LINK_ORIGIN] });
  await assert.rejects(missing.getAccount("ca_1"), code("config_missing"));
  assert.equal(calls, 2, "absent project key never sends a request");
});

test("service: capability auth, bounded catalog without private auth config, provider namespace derived by the service", async t => {
  const lab = await serviceLab(t), cap = lab.issue(P1);
  assert.equal((await call(lab, null, null, "GET", "/v1/catalog")).status, 401);
  assert.equal((await call(lab, cap, "inst_other", "GET", "/v1/catalog")).status, 401);
  assert.equal((await call(lab, "x".repeat(40), P1.installationId, "GET", "/v1/catalog")).status, 401);
  const catalog = await call(lab, cap, P1.installationId, "GET", "/v1/catalog");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.services[0].serviceId, "gmail");
  assert.deepEqual(catalog.body.services[0].authorizationOrigins, [LINK_ORIGIN]);
  assert.ok(!JSON.stringify(catalog.body).includes("ac_gmail_synthetic"), "auth config id stays inside the service");
  assert.equal((await call(lab, cap, P1.installationId, "GET", "/v1/catalog?x=1")).status, 400);
  assert.equal(lab.composio.requests.length, 0);
});

test("service: one Connect Link per request id, replay never re-posts, stale pin refused, callback is only a hint", async t => {
  const lab = await serviceLab(t), cap = lab.issue(P1), pin = lab.service.pin;
  const request = { requestId: "req-1", profileId: "default", serviceId: "gmail", catalogPin: pin };
  const first = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", request);
  assert.equal(first.status, 201);
  assert.equal(first.body.attempt.state, "awaiting_user");
  assert.ok(first.body.authorizationURL.startsWith(`${LINK_ORIGIN}/link/`));
  const link = lab.composio.requests.find(r => r.path.endsWith("/connected_accounts/link"))!;
  const sentBody = link.body as Record<string, string>;
  assert.equal(sentBody.user_id, `dx:${P1.installationId}:${P1.ownerId}:default`);
  assert.equal(sentBody.alias, `dx-${first.body.attempt.attemptId.slice(4)}`);
  assert.ok(sentBody.callback_url!.startsWith(`${SERVICE_ORIGIN}/v1/callback/${first.body.attempt.attemptId}?state=`));
  const replay = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", request);
  assert.equal(replay.status, 200); assert.equal(replay.body.authorizationURL, null, "link is never re-served");
  assert.equal(lab.composio.count("POST", "/api/v3.1/connected_accounts/link"), 1);
  assert.equal((await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", { ...request, profileId: "other" })).status, 409);
  assert.equal((await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", { ...request, requestId: "req-2", catalogPin: "0".repeat(64) })).status, 412);
  assert.equal(lab.composio.count("POST", "/api/v3.1/connected_accounts/link"), 1);
  // Browser return: a wrong nonce records nothing; the right one records a hint but never activates.
  const nonce = new URL(sentBody.callback_url!).searchParams.get("state")!;
  const cb = async (q: string) => (await fetch(`${lab.url}/v1/callback/${first.body.attempt.attemptId}?${q}`)).status;
  assert.equal(await cb(`state=${"A".repeat(43)}&status=success&connected_account_id=${first.body.attempt.accountRef}`), 400);
  assert.equal(await cb(`state=${nonce}&status=success&connected_account_id=ca_other`), 400);
  assert.equal(await cb(`state=${nonce}&status=success&connected_account_id=${first.body.attempt.accountRef}`), 200);
  const pending = await call(lab, cap, P1.installationId, "GET", "/v1/authorizations/req-1");
  assert.equal(pending.body.state, "awaiting_user"); assert.equal(pending.body.callback, "success");
  lab.composio.complete(first.body.attempt.accountRef, "Ana Sintética");
  const active = await call(lab, cap, P1.installationId, "GET", "/v1/authorizations/req-1");
  assert.equal(active.body.state, "active");
  assert.deepEqual(active.body.identity, { confirmation: "provider_display_name", value: "Ana Sintética", kind: "display_name", source: "provider_label" });
  const ownership = lab.composio.requests.filter(r => r.method === "GET" && r.path === "/api/v3.1/connected_accounts").at(-1)!;
  assert.deepEqual(ownership.query.user_ids, [`dx:${P1.installationId}:${P1.ownerId}:default`]);
  assert.deepEqual(ownership.query.connected_account_ids, [first.body.attempt.accountRef]);
});

test("service: lost provider ACK stays unknown, reconciles by alias with reads only, never a second link", async t => {
  const lab = await serviceLab(t), cap = lab.issue(P1);
  lab.composio.faults.link = "drop";
  const request = { requestId: "req-lost", profileId: "default", serviceId: "gmail", catalogPin: lab.service.pin };
  const lost = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", request);
  assert.equal(lost.status, 502); assert.deepEqual(lost.body, { error: "outcome_unknown", outcome: "unknown" });
  const replay = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", request);
  assert.equal(replay.status, 200); assert.equal(replay.body.attempt.state, "unknown");
  const read = await call(lab, cap, P1.installationId, "GET", "/v1/authorizations/req-lost");
  assert.equal(read.body.state, "awaiting_user"); assert.ok(read.body.accountRef?.startsWith("ca_"));
  assert.equal(lab.composio.count("POST", "/api/v3.1/connected_accounts/link"), 1);
  lab.composio.complete(read.body.accountRef);
  assert.equal((await call(lab, cap, P1.installationId, "GET", "/v1/authorizations/req-lost")).body.state, "active");
  // Refused before effect: failed, and the provider never received a link request.
  lab.composio.faults.link = "429";
  const limited = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", { ...request, requestId: "req-429" });
  assert.equal(limited.status, 429); assert.equal(limited.body.outcome, "not_applied");
});

test("service: other installations cannot see, execute or disconnect an account; executions are pinned and never repeated", async t => {
  const lab = await serviceLab(t), cap = lab.issue(P1), other = lab.issue(P2);
  const start = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", { requestId: "r1", profileId: "default", serviceId: "gmail", catalogPin: lab.service.pin });
  const ref = start.body.attempt.accountRef as string;
  lab.composio.complete(ref);
  await call(lab, cap, P1.installationId, "GET", "/v1/authorizations/r1");
  assert.equal((await call(lab, other, P2.installationId, "GET", `/v1/accounts/${ref}`)).status, 404);
  const exec = { requestId: "x1", profileId: "default", accountRef: ref, serviceId: "gmail", toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS", version: VERSION, arguments: { query: "in:inbox" } };
  assert.equal((await call(lab, other, P2.installationId, "POST", "/v1/executions", exec)).status, 404);
  assert.equal((await call(lab, cap, P1.installationId, "POST", "/v1/executions", { ...exec, slug: "GMAIL_DELETE_EVERYTHING" })).status, 404);
  assert.equal((await call(lab, cap, P1.installationId, "POST", "/v1/executions", { ...exec, version: "20991231_00" })).status, 404);
  const done = await call(lab, cap, P1.installationId, "POST", "/v1/executions", exec);
  assert.equal(done.status, 200); assert.deepEqual(done.body.data, { slug: "GMAIL_FETCH_EMAILS", version: VERSION, echo: { query: "in:inbox" } });
  const upstream = lab.composio.requests.filter(r => r.path.startsWith("/api/v3.1/tools/execute/") && !r.path.endsWith("/proxy"));
  assert.equal(upstream.length, 1);
  assert.deepEqual(upstream[0]!.body, { arguments: { query: "in:inbox" }, version: VERSION, user_id: `dx:${P1.installationId}:${P1.ownerId}:default`, connected_account_id: ref });
  assert.equal((await call(lab, cap, P1.installationId, "POST", "/v1/executions", exec)).status, 409, "a reused request id is refused, never re-executed");
  lab.composio.faults.execute = "drop";
  const unknown = await call(lab, cap, P1.installationId, "POST", "/v1/executions", { ...exec, requestId: "x2" });
  assert.equal(unknown.status, 502);
  assert.equal(lab.composio.requests.filter(r => r.path.startsWith("/api/v3.1/tools/execute/") && !r.path.endsWith("/proxy")).length, 2);
  assert.equal((await call(lab, other, P2.installationId, "POST", `/v1/accounts/${ref}/disconnect`, { requestId: "d1" })).status, 404);
  assert.equal(lab.composio.count("DELETE", "/api/v3.1/connected_accounts/"), 0);
});

test("service: disconnect deletes once with revocation requested; unknown delete is settled by a read; restart marks in-flight unknown", async t => {
  const lab = await serviceLab(t), cap = lab.issue(P1);
  const refs: string[] = [];
  for (const id of ["a", "b"]) {
    const s = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", { requestId: id, profileId: "default", serviceId: "gmail", catalogPin: lab.service.pin });
    refs.push(s.body.attempt.accountRef); lab.composio.complete(s.body.attempt.accountRef); await call(lab, cap, P1.installationId, "GET", `/v1/authorizations/${id}`);
  }
  const done = await call(lab, cap, P1.installationId, "POST", `/v1/accounts/${refs[0]}/disconnect`, { requestId: "d-a" });
  assert.deepEqual(done.body, { version: 1, requestId: "d-a", accountRef: refs[0], upstream: "deleted", revocation: "requested" });
  const del = lab.composio.requests.find(r => r.method === "DELETE")!;
  assert.deepEqual(del.query, { revoke_on_delete: ["true"] });
  assert.deepEqual((await call(lab, cap, P1.installationId, "POST", `/v1/accounts/${refs[0]}/disconnect`, { requestId: "d-a" })).body, done.body);
  assert.equal(lab.composio.count("DELETE", "/api/v3.1/connected_accounts/"), 1);
  assert.equal((await call(lab, cap, P1.installationId, "GET", `/v1/accounts/${refs[0]}`)).body.state, "absent");
  lab.composio.faults.delete = "drop";
  assert.equal((await call(lab, cap, P1.installationId, "POST", `/v1/accounts/${refs[1]}/disconnect`, { requestId: "d-b" })).status, 502);
  const settled = await call(lab, cap, P1.installationId, "POST", `/v1/accounts/${refs[1]}/disconnect`, { requestId: "d-b" });
  assert.equal(settled.status, 200); assert.equal(settled.body.upstream, "deleted");
  assert.equal(lab.composio.count("DELETE", "/api/v3.1/connected_accounts/"), 2, "the unknown delete was read, not re-sent");
  // Unknown delete that did NOT apply (500 before the provider effect): reading proves the account is still present, so the
  // explicit re-send of the SAME request performs the delete once; a different request id is never needed.
  const third = await call(lab, cap, P1.installationId, "POST", "/v1/authorizations", { requestId: "c", profileId: "default", serviceId: "gmail", catalogPin: lab.service.pin });
  lab.composio.complete(third.body.attempt.accountRef); await call(lab, cap, P1.installationId, "GET", "/v1/authorizations/c");
  lab.composio.faults.delete = "500";
  assert.equal((await call(lab, cap, P1.installationId, "POST", `/v1/accounts/${third.body.attempt.accountRef}/disconnect`, { requestId: "d-c" })).status, 502);
  assert.ok(lab.composio.accounts.has(third.body.attempt.accountRef));
  const resent = await call(lab, cap, P1.installationId, "POST", `/v1/accounts/${third.body.attempt.accountRef}/disconnect`, { requestId: "d-c" });
  assert.equal(resent.status, 200); assert.equal(resent.body.upstream, "deleted");
  assert.equal(lab.composio.accounts.has(third.body.attempt.accountRef), false);
  await lab.restart();
  assert.equal((await call(lab, cap, P1.installationId, "GET", "/v1/authorizations/a")).body.state, "active");
  for (const file of readdirSync(lab.dir)) {
    const bytes = readFileSync(join(lab.dir, file));
    for (const secret of [COMPOSIO_KEY, ACCESS_TOKEN, REFRESH_TOKEN, cap, "lk_"]) assert.ok(!bytes.includes(secret), `${file} holds no credential or link`);
  }
});
