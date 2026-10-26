import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { OpenVikingAdapter } from '../packages/context/dist/openviking-adapter.js';
import { OpenVikingIdentityMapper, openVikingRevisionUri, openVikingPrivateMemoryRoot } from '../packages/context/dist/openviking-identity.js';
import { OpenVikingProvisioner } from '../packages/context/dist/openviking-provisioning.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const rootKey = 'synthetic-host-root-key';
const userKey = identity => [identity.accountId, identity.userId, '0'.repeat(64)].map(part => Buffer.from(part).toString('base64url')).join('.');
const input = (operationKey = 'project-1') => ({ operationKey, recordId: 'note-1', revision: 1, markdown: 'Nota sintética: conferir o inventário.', sha256: sha('Nota sintética: conferir o inventário.') });
const isCode = code => error => error.code === code;

// Synthetic file journal tests a restart between adapters; production must supply its canonical ledger + fencing.
function journalFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dexter-openviking-journal-')), path = join(dir, 'synthetic-journal.json');
  writeFileSync(path, '{}');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    async claim(binding) {
      const rows = JSON.parse(readFileSync(path, 'utf8')), row = rows[binding.operationKey];
      if (row) { assert.deepEqual(row.binding, binding); return 'reconcile'; }
      rows[binding.operationKey] = { binding, state: 'dispatched' };
      writeFileSync(path, JSON.stringify(rows));
      return 'send';
    },
    async record(receipt) {
      const rows = JSON.parse(readFileSync(path, 'utf8')), row = rows[receipt.operationKey];
      assert.ok(row);
      if (row.receipt?.outcome !== 'confirmed') row.receipt = receipt;
      writeFileSync(path, JSON.stringify(rows));
    },
    rows: () => JSON.parse(readFileSync(path, 'utf8')),
  };
}

async function serverFixture(t) {
  const mapper = new OpenVikingIdentityMapper('synthetic-workspace'), identity = mapper.bot('synthetic-bot');
  const state = { identity, mapper, files: new Map(), requests: [], accounts: new Set(), users: new Map(), hit: null,
    mode: 'normal', healthRole: 'user', configured: true, indexStatus: 'queued', timers: new Set() };
  const send = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const ok = (res, result) => send(res, { status: 'ok', result });
  const missing = res => send(res, { status: 'error', error: { code: 'NOT_FOUND', message: 'Synthetic item absent' } }, 404);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), key = req.headers['x-api-key'];
    let data = ''; for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : null;
    state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body,
      kind: key === rootKey ? 'root' : key === userKey(identity) ? 'bot' : 'other', headers: Object.keys(req.headers) });
    if (url.pathname === '/health') {
      return send(res, { status: 'ok', healthy: true, version: 'synthetic-pinned-contract', auth_mode: 'api_key',
        role: key === rootKey ? 'root' : state.healthRole, account_id: identity.accountId, user_id: identity.userId });
    }
    if (url.pathname.startsWith('/api/v1/admin')) {
      if (key !== rootKey) return send(res, { status: 'error', error: { code: 'PERMISSION_DENIED' } }, 403);
      if (url.pathname === '/api/v1/admin/accounts') {
        if (req.method === 'POST') { state.accounts.add(body.account_id); return ok(res, { account_id: body.account_id, admin_user_id: body.admin_user_id }); }
        return ok(res, state.accounts.has(url.searchParams.get('name')) ? [{ account_id: url.searchParams.get('name') }] : []);
      }
      if (url.pathname.endsWith('/settings')) return ok(res, { account_id: identity.accountId, user_id: identity.userId,
        memory_policy: { self: { enabled: !state.configured }, peer: { enabled: false }, working_memory: { enabled: false }, memory_types: [] } });
      if (req.method === 'POST') {
        state.users.set(body.user_id, { user_id: body.user_id, role: body.role });
        if (state.mode === 'lost-provision') return req.socket.destroy();
        return ok(res, { account_id: identity.accountId, user_id: body.user_id, user_key: userKey(identity) });
      }
      return ok(res, state.users.has(url.searchParams.get('name')) ? [state.users.get(url.searchParams.get('name'))] : []);
    }
    if (key !== userKey(identity)) return send(res, { status: 'error', error: { code: 'PERMISSION_DENIED' } }, 403);
    if (url.pathname === '/api/v1/search/find') {
      const hit = state.hit ?? { uri: openVikingRevisionUri(identity, input()), context_type: 'resource', level: 2, score: 0.91,
        abstract: 'PRIVATE BACKEND SUMMARY MUST NOT ENTER EVIDENCE', content: 'FORGED BODY' };
      return ok(res, { memories: [], resources: [hit], skills: [], total: 1 });
    }
    if (url.pathname === '/api/v1/content/write') {
      if (state.mode === 'delayed-write') {
        const timer = setTimeout(() => { state.files.set(body.uri, body.content); state.timers.delete(timer); }, 100);
        state.timers.add(timer); return;
      }
      if (state.mode !== 'ack-missing') state.files.set(body.uri, state.mode === 'hash-mismatch' ? 'Changed bytes' : body.content);
      if (state.mode === 'lost-ack') return req.socket.destroy();
      return ok(res, { uri: body.uri, mode: 'create', content_updated: true, written_bytes: Buffer.byteLength(body.content),
        semantic_status: 'queued', vector_status: state.indexStatus, queue_status: null });
    }
    if (url.pathname === '/api/v1/content/read') {
      if (state.mode === 'read-wrong-404') return send(res, { status: 'error', error: { code: 'ROUTE_NOT_FOUND' } }, 404);
      const text = state.files.get(url.searchParams.get('uri'));
      if (text === undefined) return missing(res);
      if (state.mode === 'oversize') return ok(res, 'x'.repeat(3000));
      return ok(res, text);
    }
    missing(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const timer of state.timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  state.adapter = (journal, options = {}) => {
    const adapter = new OpenVikingAdapter({ origin: state.origin, identity, credential: () => userKey(identity), ...(journal ? { journal } : {}), ...options });
    t.after(() => adapter.close()); return adapter;
  };
  state.writes = () => state.requests.filter(r => r.path === '/api/v1/content/write');
  return state;
}

test('OpenViking authenticated fixed-target recall validates refs and never exposes backend summary/body', async t => {
  const f = await serverFixture(t), adapter = f.adapter();
  assert.deepEqual(await adapter.status(), { identityVerified: true, content: 'unproven', indexing: 'unproven', upstreamPin: '92285e5b373ef927021544597b65e56bc9d0d5c8' });
  const hits = await adapter.recall({ query: 'Onde está a nota?', limit: 2 });
  assert.equal(hits[0].recordId, 'note-1');
  assert.equal(hits[0].sha256, input().sha256);
  assert.ok(!JSON.stringify(hits).includes('PRIVATE BACKEND'));
  assert.ok(!JSON.stringify(hits).includes('FORGED BODY'));
  const call = f.requests.find(r => r.path.endsWith('/find'));
  assert.equal(call.body.target_uri, openVikingPrivateMemoryRoot(f.identity));
  assert.equal(call.body.context_type, 'resource'); assert.equal(call.body.level, 2);
  assert.equal(call.body.read_content, false);
  assert.ok(f.requests.every(r => !r.headers.includes('x-openviking-user') && !r.headers.includes('x-openviking-account')));
  await assert.rejects(adapter.recall({ query: 'test', target_uri: 'viking://resources' }), isCode('input'));
  await assert.rejects(adapter.recall({ query: 'test', limit: 21 }), isCode('input'));
  f.hit = { ...f.hit, uri: openVikingRevisionUri(f.mapper.bot('other'), input()), context_type: 'resource', level: 2, score: 0.4 };
  await assert.rejects(adapter.recall({ query: 'test' }), isCode('scope'));
});

test('OpenViking root/foreign key, forged identity and admin role are rejected before data requests', async t => {
  const f = await serverFixture(t);
  for (const key of [rootKey, userKey(f.mapper.bot('other'))]) await assert.rejects(f.adapter(null, { credential: () => key }).status(), isCode('identity'));
  assert.equal(f.requests.length, 0);
  assert.throws(() => f.adapter(null, { identity: { ...f.identity } }), isCode('identity'));
  f.healthRole = 'admin';
  await assert.rejects(f.adapter().recall({ query: 'test' }), isCode('identity'));
  assert.ok(f.requests.every(r => r.path === '/health'));
  for (const origin of ['http://example.invalid:1234', f.origin + '/wrong', 'https://user:secret@example.invalid', 'https://example.invalid?x=1']) assert.throws(() => f.adapter(null, { origin }), isCode('configuration'));
});

test('OpenViking immutable create + raw readback confirms bytes, preserving unproven index and dedup after reopen', async t => {
  const f = await serverFixture(t), journal = journalFixture(t), adapter = f.adapter(journal);
  const receipt = await adapter.project(input());
  assert.equal(receipt.outcome, 'confirmed'); assert.equal(receipt.indexing, 'unproven'); assert.equal(receipt.taskId, null);
  assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].body.mode, 'create');
  assert.equal(f.writes()[0].body.wait, false);
  adapter.close();
  assert.equal((await f.adapter(journal).project(input())).outcome, 'confirmed');
  assert.equal(f.writes().length, 1);
  const read = await f.adapter().read({ recordId: input().recordId, revision: 1, sha256: input().sha256 });
  assert.equal(read.markdown, input().markdown);
  assert.ok(f.requests.filter(r => r.path.endsWith('/read')).every(r => r.query.get('raw') === 'true'));
  const serialized = JSON.stringify(receipt) + inspect(adapter) + JSON.stringify(adapter);
  assert.ok(!serialized.includes(userKey(f.identity))); assert.ok(!serialized.includes(input().markdown));
  await assert.rejects(f.adapter().project(input('no-journal')), isCode('configuration'));
  await assert.rejects(f.adapter(journal).project({ ...input(), markdown: 'Different', sha256: sha('Different') }), isCode('journal'));
  assert.equal(f.writes().length, 1);
});

test('OpenViking postcommit lost ACK enters unknown; restart reconciles exact URI/hash with no second POST', async t => {
  const f = await serverFixture(t), journal = journalFixture(t); f.mode = 'lost-ack';
  const adapter = f.adapter(journal), unknown = await adapter.project(input());
  assert.equal(unknown.outcome, 'unknown'); assert.equal(unknown.reason, 'network');
  adapter.close(); f.mode = 'normal';
  assert.equal((await f.adapter(journal).project(input())).outcome, 'confirmed');
  assert.equal(f.writes().length, 1);
});

test('OpenViking concurrent workers share a durable operation claim and issue a single create', async t => {
  const f = await serverFixture(t), journal = journalFixture(t);
  const receipts = await Promise.all([f.adapter(journal).project(input()), f.adapter(journal).project(input())]);
  assert.equal(f.writes().length, 1);
  assert.ok(receipts.some(receipt => receipt.outcome === 'confirmed'));
  assert.equal(journal.rows()['project-1'].receipt.outcome, 'confirmed');
});

test('OpenViking cancellation of owned HTTP after dispatch remains unknown and never resets replay authority', async t => {
  const f = await serverFixture(t), journal = journalFixture(t); f.mode = 'delayed-write';
  const adapter = f.adapter(journal), pending = adapter.project(input());
  while (f.writes().length === 0) await new Promise(resolve => setImmediate(resolve));
  adapter.close();
  const receipt = await pending;
  assert.equal(receipt.outcome, 'unknown'); assert.equal(receipt.reason, 'closed');
  assert.equal(journal.rows()['project-1'].state, 'dispatched');
  assert.equal(f.writes().length, 1);
});

test('OpenViking ACK without readback stays unknown and missing reconcile cannot replay a late write', async t => {
  const f = await serverFixture(t), journal = journalFixture(t); f.mode = 'ack-missing';
  assert.equal((await f.adapter(journal).project(input())).outcome, 'unknown');
  assert.equal((await f.adapter(journal).project(input())).reason, 'missing');
  assert.equal(f.writes().length, 1);
  f.files.set(openVikingRevisionUri(f.identity, input()), input().markdown);
  assert.equal((await f.adapter(journal).project(input())).outcome, 'confirmed');
  assert.equal(f.writes().length, 1);
});

test('OpenViking timeout after write remains unknown and does not assume abort reverses the server effect', async t => {
  const f = await serverFixture(t), journal = journalFixture(t); f.mode = 'delayed-write';
  const unknown = await f.adapter(journal, { timeoutMs: 30 }).project(input());
  assert.equal(unknown.outcome, 'unknown'); assert.equal(unknown.reason, 'timeout');
  await new Promise(resolve => setTimeout(resolve, 120));
  f.mode = 'normal';
  assert.equal((await f.adapter(journal).project(input())).outcome, 'confirmed');
  assert.equal(f.writes().length, 1);
});

test('OpenViking mismatch, malformed 404 and oversized readback cannot produce confirmed receipt or disclose raw bytes', async t => {
  const f = await serverFixture(t), journal = journalFixture(t); f.mode = 'hash-mismatch';
  const receipt = await f.adapter(journal).project(input());
  assert.equal(receipt.outcome, 'conflict'); assert.equal(receipt.reason, 'hash_mismatch');
  await assert.rejects(f.adapter().read({ recordId: input().recordId, revision: 1, sha256: input().sha256 }), isCode('protocol'));
  f.mode = 'read-wrong-404';
  await assert.rejects(f.adapter().read({ recordId: input().recordId, revision: 1, sha256: input().sha256 }), isCode('protocol'));
  f.mode = 'oversize';
  await assert.rejects(f.adapter(null, { maxResponseBytes: 512 }).read({ recordId: input().recordId, revision: 1, sha256: input().sha256 }), isCode('too_large'));
});

test('OpenViking deadlines bound a noncooperative fetch and sanitize credential/network exceptions', async t => {
  const f = await serverFixture(t), secret = 'synthetic-secret-must-not-leak';
  await assert.rejects(f.adapter(null, { timeoutMs: 10, fetch: async () => new Promise(() => {}) }).status(), isCode('timeout'));
  const adapter = f.adapter(null, { credential: () => { throw new Error(secret); } });
  await assert.rejects(adapter.status(), error => error.code === 'identity' && !inspect(error).includes(secret));
  const broken = f.adapter(null, { fetch: async () => { throw new Error(userKey(f.identity)); } });
  await assert.rejects(broken.status(), error => error.code === 'network' && !inspect(error).includes(userKey(f.identity)));
  broken.close(); await assert.rejects(broken.status(), isCode('closed'));
});

test('OpenViking snapshots approved projection bytes before asynchronous custody/journal awaits', async t => {
  const f = await serverFixture(t), base = journalFixture(t), original = input(), mutable = { ...original };
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const journal = { record: base.record, async claim(binding) { entered(); await gate; return base.claim(binding); } };
  const pending = f.adapter(journal).project(mutable);
  await started; mutable.markdown = 'UNAPPROVED'; mutable.sha256 = sha('UNAPPROVED'); mutable.recordId = 'other-note'; release();
  const receipt = await pending;
  assert.equal(receipt.sha256, original.sha256); assert.equal(receipt.recordId, original.recordId);
  assert.equal(f.writes()[0].body.content, original.markdown);
});

test('OpenViking host-only provisioning creates one account/user, privately stores key and proves identity separately from index', async t => {
  const f = await serverFixture(t), journal = journalFixture(t), privateKeys = new Map();
  const provisioner = new OpenVikingProvisioner({ origin: f.origin, rootCredential: () => rootKey, journal,
    custody: { async load(identity) { return privateKeys.get(identity.userId) ?? null; }, async save(identity, key) { privateKeys.set(identity.userId, key); } } });
  t.after(() => provisioner.close());
  assert.equal((await provisioner.ensureAccount(f.identity, 'account-1')).outcome, 'account_exists');
  const receipt = await provisioner.ensureBot(f.identity, 'user-1');
  assert.equal(receipt.outcome, 'identity_verified'); assert.equal(receipt.indexing, 'unproven'); assert.equal(receipt.content, 'unproven');
  assert.equal(privateKeys.get(f.identity.userId), userKey(f.identity));
  assert.equal((await provisioner.ensureBot(f.identity, 'user-1')).outcome, 'identity_verified');
  assert.equal(f.requests.filter(r => r.path.endsWith('/users') && r.method === 'POST').length, 1);
  assert.ok(f.requests.filter(r => r.kind === 'root').every(r => r.path === '/health' || r.path.startsWith('/api/v1/admin')));
  assert.ok(f.requests.filter(r => r.path.endsWith('/users') && r.method === 'GET').every(r => r.query.get('include_credentials') === 'false'));
  const create = f.requests.find(r => r.path.endsWith('/users') && r.method === 'POST');
  assert.deepEqual(create.body.user_config.memory_policy, { self: { enabled: false }, peer: { enabled: false }, working_memory: { enabled: false }, memory_types: [] });
  assert.ok(!JSON.stringify(receipt).includes(userKey(f.identity)) && !inspect(provisioner).includes(rootKey));
  f.configured = false;
  assert.equal((await provisioner.ensureBot(f.identity, 'user-1')).outcome, 'blocked_configuration');
});

test('OpenViking lost user-creation response reconciles existence and requires private credential recovery without re-creation/rotation', async t => {
  const f = await serverFixture(t), journal = journalFixture(t); f.mode = 'lost-provision';
  const custody = { async load() { return null; }, async save() { assert.fail('No key response exists to store'); } };
  const first = new OpenVikingProvisioner({ origin: f.origin, rootCredential: () => rootKey, journal, custody });
  assert.equal((await first.ensureBot(f.identity, 'user-1')).outcome, 'unknown'); first.close(); f.mode = 'normal';
  const reopened = new OpenVikingProvisioner({ origin: f.origin, rootCredential: () => rootKey, journal, custody });
  t.after(() => reopened.close());
  assert.equal((await reopened.ensureBot(f.identity, 'user-1')).outcome, 'credential_required');
  assert.equal(f.requests.filter(r => r.path.endsWith('/users') && r.method === 'POST').length, 1);
  assert.ok(!f.requests.some(r => r.path.endsWith('/key')));
});
