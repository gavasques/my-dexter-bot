import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretKey } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BotSchema } from '@dexter/contracts';
import { HostStore, SCHEMA_VERSION } from '@dexter/hub';
import { createHostApp } from '@dexter/hub/http';
import { captureInspectionSnapshot, restoreForInspection } from '@dexter/operations';

test('bot metadata CAS, unique Master, migration defaults and encrypted snapshot roundtrip', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dexter-bot-profile-')));
  let store;
  try {
    const dir = join(root, 'host');
    store = new HostStore({ dataDir: dir });
    const first = store.createBot({ name: 'Codex one', profileId: 'synthetic', engine: 'codex' });
    const second = store.createBot({ name: 'Codex two', profileId: 'synthetic', engine: 'codex' });
    assert.equal(first.revision, 0); assert.equal(first.canSendActions, false);
    const legacy = { ...first }; for (const field of ['roleDescription','avatarEmoji','canSeeBots','canReceiveOrders','canSendActions','isMaster','revision']) delete legacy[field];
    assert.equal(BotSchema.parse(legacy).revision, 0);
    const path = store.databasePath;
    store.close(); store = null;
    // Simulate the existing v4 database to exercise the actual additive migration.
    const old = new DatabaseSync(path);
    old.exec('DROP INDEX bots_one_master_per_owner');
    for (const column of ['role_description','avatar_emoji','can_see_bots','can_receive_orders','can_send_actions','is_master','revision']) old.exec(`ALTER TABLE bots DROP COLUMN ${column}`);
    old.exec('PRAGMA user_version=4'); old.close();
    store = new HostStore({ dataDir: dir });
    assert.deepEqual(store.getBot(first.id), first);
    const app = createHostApp(store);
    const request = (url, body) => app.request(`http://127.0.0.1${url}`, { method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    assert.equal((await app.request(`http://127.0.0.1/v1/bots/${first.id}/peers`)).status, 403);
    assert.equal((await request(`/v1/bots/${first.id}`, { expectedRevision:0, roleDescription:'Coordena tarefas sintéticas', avatarEmoji:'🧑‍💻', isMaster:true, canSeeBots:false, canSendActions:true })).status, 200);
    const master = store.getBot(first.id);
    assert.equal(master.isMaster, true); assert.equal(master.canSeeBots, true); assert.equal(master.revision, 1);
    assert.equal((await request(`/v1/bots/${second.id}`, { expectedRevision:0, isMaster:true })).status, 409);
    assert.equal(store.getBot(second.id).revision, 0);
    assert.equal((await request(`/v1/bots/${first.id}`, { expectedRevision:0, name:'stale' })).status, 409);
    assert.equal((await request(`/v1/bots/${first.id}`, { expectedRevision:1, avatarEmoji:'x\n' })).status, 400);
    assert.equal((await request(`/v1/bots/${first.id}`, { expectedRevision:1, roleDescription:'x'.repeat(2001) })).status, 400);
    assert.equal((await request(`/v1/bots/${first.id}`, { expectedRevision:1, unexpected:true })).status, 400);
    const peers = await (await app.request(`http://127.0.0.1/v1/bots/${first.id}/peers`)).json();
    assert.deepEqual(peers.items, [{ id:second.id, name:second.name, roleDescription:'', canReceiveOrders:false }]);
    assert.equal(store.getGrant(first.id, 'fixture.action', 'dest'), null);
    store.close(); store = new HostStore({ dataDir:dir });
    assert.deepEqual(store.getBot(first.id), master);
    mkdirSync(join(root,'out'), {mode:0o700});
    const secret = createSecretKey(Buffer.alloc(32, 31));
    const key = { keyId:'synthetic-bot-profile', use:operation => operation(secret) };
    const artifact = captureInspectionSnapshot({ source:store, include:{context:false,agenda:false,deviceRegistry:false,deviceSurface:false}, key, output:join(root,'out','profile.dxg8') });
    const restored = restoreForInspection({ artifact:artifact.path, key, destination:join(root,'inspection') });
    const copy = new DatabaseSync(join(restored.destination,'inspection','hub.inspect.sqlite'), {readOnly:true});
    try {
      const row = copy.prepare('SELECT * FROM bots WHERE id=?').get(first.id);
      assert.equal(row.role_description, master.roleDescription); assert.equal(row.avatar_emoji, master.avatarEmoji);
      assert.equal(row.is_master, 1); assert.equal(row.can_see_bots, 1); assert.equal(row.can_send_actions, 1); assert.equal(row.revision, 1);
      assert.equal(copy.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    } finally { copy.close(); }
  } finally { store?.close(); rmSync(root,{recursive:true,force:true}); }
});
