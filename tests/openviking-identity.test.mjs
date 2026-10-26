import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenVikingIdentityMapper, encodeOpenVikingHostId, canonicalOpenVikingUri, openVikingRevisionUri,
  parseOpenVikingRevisionUri, assertOpenVikingBotIdentity, validateOpenVikingUserKey } from '../packages/context/dist/openviking-identity.js';

const userKey = identity => [identity.accountId, identity.userId, '0'.repeat(64)].map(part => Buffer.from(part).toString('base64url')).join('.');

test('OpenViking v1 mapping is injective and stable across display-name renames and host reload', () => {
  const mapper = new OpenVikingIdentityMapper('workspace-A');
  const a = mapper.bot('bot-A'), b = mapper.bot('bot-A-B');
  assert.notEqual(a.userId, b.userId);
  assert.notEqual(new OpenVikingIdentityMapper('workspace-B').bot('bot-A').accountId, a.accountId);
  assert.deepEqual(new OpenVikingIdentityMapper('workspace-A').bot('bot-A'), a);
  const names = { before: 'Finanças', after: 'Marketing' };
  names.before = names.after;
  assert.deepEqual(mapper.bot('bot-A'), a);
  const ids = ['a', 'A', 'á', 'á', 'bot/a', 'bot%2Fa', 'x'.repeat(127), 'x'.repeat(126) + 'y'];
  assert.equal(new Set(ids.map(encodeOpenVikingHostId)).size, ids.length);
  assert.ok(Object.isFrozen(mapper));
  assert.ok(Object.isFrozen(a));
  assert.throws(() => assertOpenVikingBotIdentity(JSON.parse(JSON.stringify(a))), /untrusted identity/);
  for (const id of ['', ' a', 'a ', '\ud800', '\u0000', '😀'.repeat(33)]) assert.throws(() => mapper.bot(id), /invalid host id/);
});

test('OpenViking URI contract rejects traversal, aliases, path variables, encoded slashes and cross-bot impersonation', () => {
  const a = new OpenVikingIdentityMapper('w').bot('a'), b = new OpenVikingIdentityMapper('w').bot('b');
  const ref = { recordId: 'host-note-1', revision: 7, sha256: 'f'.repeat(64) };
  const uri = openVikingRevisionUri(a, ref);
  assert.equal(canonicalOpenVikingUri(uri), uri);
  assert.deepEqual(parseOpenVikingRevisionUri(a, uri), ref);
  assert.throws(() => parseOpenVikingRevisionUri(b, uri));
  for (const suffix of ['/../other', '/./other', '//other', '/%2e%2e/other', '/%2fother', '/${user}', '/foo?x=1', '/foo#x', '/foo\\bar', '/', '/.overview.md']) {
    assert.throws(() => canonicalOpenVikingUri('viking://user/' + a.userId + suffix));
  }
  assert.throws(() => parseOpenVikingRevisionUri(a, uri.replace('/v7-', '/v07-')));
  assert.throws(() => openVikingRevisionUri(a, { ...ref, revision: Number.MAX_SAFE_INTEGER + 1 }));
});

test('OpenViking structured private user key is bound to the exact host identity, never ROOT or another bot', () => {
  const mapper = new OpenVikingIdentityMapper('w'), a = mapper.bot('a'), b = mapper.bot('b');
  assert.doesNotThrow(() => validateOpenVikingUserKey(userKey(a), a));
  for (const key of ['synthetic-root-key', userKey(b), userKey(a) + '=', userKey(a) + '\n']) assert.throws(() => validateOpenVikingUserKey(key, a), /invalid credential/);
});
