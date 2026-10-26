import { sendMemoryIdentity } from "./fixtures/memory-identity-channel.js";
// Synthetic loopback TLS and child fixtures only. No engine inference or production identity.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';
import { HostStore, HostError } from '@dexter/hub';
import { createHostApp } from '@dexter/hub/http';
import { DeviceClient, FILE_APPEND, generateSyntheticIdentity, pairDevice, type HostTrust } from '@dexter/devices';
import type { HostServices as ServicesType } from '../packages/cli/src/host-services.js';
const { HostServices } = await import(pathToFileURL(resolve('packages/cli/dist/host-services.js')).href) as { HostServices: typeof ServicesType };
const { DeviceServices } = await import(pathToFileURL(resolve('packages/cli/dist/device-services.js')).href) as typeof import('../packages/cli/src/device-services.js');
const until = async (check: () => boolean, ms = 10000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('fixture_timeout'); await new Promise(r => setTimeout(r, 5)); } };
const locked = (error: unknown) => error instanceof HostError && error.code === 'host_locked';
async function lab(t: TestContext, receiptTimeoutMs = 2000) {
  const root = mkdtempSync(join(tmpdir(), 'dx-host-device-')); chmodSync(root, 0o700);
  const identity = generateSyntheticIdentity(join(root, 'host-id'), 'host');
  const peer = generateSyntheticIdentity(join(root, 'peer-id'), 'peer');
  const fixtures = join(root, 'fixtures'); mkdirSync(fixtures, { mode: 0o700 });
  let services = new HostServices({ dataDir: join(root, 'host'), devices: { identity, port: 0, pollWaitMs: 50, receiptTimeoutMs } });
  let url = await services.startDevices();
  const children: ChildProcess[] = []; let quarantined = false;
  t.after(async () => { writeFileSync(join(fixtures, 'release'), 'release'); for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(r => child.once('exit', () => r()))));
    if (!quarantined) await services.shutdown({ graceMs: 3000 }); rmSync(root, { recursive: true, force: true }); });
  const trust = (): HostTrust => ({ hostUrl: url, hostCertPem: identity.certPem, hostFingerprint: identity.fingerprint });
  const app = () => createHostApp(services.store, { devices: services.devicesHttp! });
  const post = (path: string, body: unknown = {}) => app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function pair() {
    const offer = services.devicesAdmin.pairingBundle({ kind: 'pair' });
    const pending = pairDevice({ dataDir: join(root, 'peer'), identity: peer, trust: trust(), offerId: offer.offerId, code: offer.code, name: 'Fixture Mac', capabilities: [FILE_APPEND], pollIntervalMs: 10 });
    await until(() => services.devicesAdmin.pendingClaims().length === 1);
    const claim = services.devicesAdmin.pendingClaims()[0]!;
    const approved = services.devicesAdmin.approveClaim(claim.claimId);
    assert.equal(services.devicesHttp!.get(approved.deviceId).presence, 'stale', 'approval alone is not authenticated presence');
    return (await pending).deviceId;
  }
  function child(held = false) {
    const configPath = join(root, `peer-config-${children.length}.json`);
    writeFileSync(configPath, JSON.stringify({ dataDir: join(root, 'peer'), identityDir: join(root, 'peer-id'), fixtureRoot: fixtures, name: 'Fixture Mac', capabilities: [FILE_APPEND], hostUrl: url, hostCertPath: join(root, 'host-id', 'cert.pem'), hostFingerprint: identity.fingerprint }), { mode: 0o600 });
    const module = held ? fileURLToPath(new URL('./fixtures/device-host-peer.js', import.meta.url)) : resolve('packages/devices/dist/daemon-main.js');
    const process = spawn(globalThis.process.execPath, held ? [module, configPath] : ['--import',fileURLToPath(new URL('./fixtures/device-memory-preload.js',import.meta.url)),module, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: globalThis.process.env.PATH } });
    const identityReady=sendMemoryIdentity(process,peer); void identityReady.catch(()=>{process.kill("SIGTERM");});
    process.stdout!.resume(); process.stderr!.resume(); children.push(process); return process;
  }
  async function stop(process: ChildProcess) { process.kill('SIGTERM'); await until(() => process.exitCode !== null || process.signalCode !== null); }
  function action(deviceId: string, policy: 'allow' | 'ask' = 'allow') {
    const bot = services.store.createBot({ name: 'Fixture', profileId: 'work', engine: 'claude' }), thread = services.store.createThread(bot.id);
    const request = { botId: bot.id, threadId: thread.id, tool: FILE_APPEND, destination: deviceId, arguments: { name: 'notes.txt', line: 'once' }, idempotencyKey: 'one' };
    assert.throws(() => services.store.requestAction(request), (e: unknown) => e instanceof HostError && e.code === 'forbidden');
    services.devicesAdmin.grant({ botId: bot.id, tool: FILE_APPEND, destination: deviceId, policy });
    return services.store.requestAction(request);
  }
  return { quarantineTeardown() { quarantined = true; }, root, fixtures, peer, identity, pair, child, stop, action, post, app, trust, get services() { return services; }, async restart() {
    await services.shutdown(); services = new HostServices({ dataDir: join(root, 'host'), devices: { identity, port: 0, pollWaitMs: 50, receiptTimeoutMs } }); url = await services.startDevices();
  } };
}

test('device preflight is pure, rejects invalid identity/remote options and snapshots getters once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dx-device-preflight-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = generateSyntheticIdentity(join(root, 'identity'), 'host');
  for (const devices of [{ identity, listenHost: 'example.com' }, { identity, port: -1 }, { identity: { certPem: identity.certPem, keyPem: 'invalid', fingerprint: identity.fingerprint } }]) {
    const dataDir = join(root, 'absent'); assert.throws(() => new HostServices({ dataDir, devices: devices as never }), HostError); assert.equal(existsSync(dataDir), false);
  }
  let reads = 0; const services = new HostServices({ dataDir: join(root, 'valid'), devices: { get identity() { reads++; return reads === 1 ? identity : undefined as never; }, pollWaitMs: 50 } });
  assert.equal(reads, 1); const admin = services.devicesAdmin; const starting = services.startDevices();
  await services.shutdown({ graceMs: 3000 }); await starting;
  assert.throws(() => admin.pendingClaims(), HostError); assert.throws(() => services.devicesAdmin, HostError);
  const reopened = new HostStore({ dataDir: join(root, 'valid') }); reopened.close();
});

test('configured HTTP rejects generic enrollment/heartbeat and never exposes TLS/pair credentials', async t => {
  const l = await lab(t), id = await l.pair();
  assert.equal((await l.post('/v1/devices', { name: 'Fake', platform: 'macos', capabilities: [] })).status, 403);
  assert.equal((await l.post(`/v1/devices/${id}/heartbeat`)).status, 403);
  assert.equal(l.services.devicesHttp!.get(id).presence, 'stale');
  const output = JSON.stringify(await (await l.app().request('/v1/devices')).json()) + inspect(l.services.devicesHttp);
  assert.equal(output.includes('PRIVATE KEY'), false); assert.equal(output.includes(l.identity.fingerprint), false); assert.equal(output.includes(l.peer.fingerprint), false);
  const a = l.action(id); assert.equal((await l.post(`/v1/actions/${a.id}/dispatch`)).status, 503); assert.equal(l.services.store.getAction(a.id).state, 'ready');
});

test('real daemon child: approval/hash, fixed action dispatch, replay, rename/restart identity and revoke', { timeout: 30000 }, async t => {
  const l = await lab(t), id = await l.pair(); let child = l.child();
  await until(() => l.services.devicesHttp!.get(id).presence === 'online');
  const a = l.action(id, 'ask'); assert.equal((await l.post(`/v1/actions/${a.id}/dispatch`)).status, 409);
  assert.throws(() => l.services.store.decideAction(a.id, { decision: 'allow', requestHash: 'a'.repeat(64) }), HostError);
  l.services.store.decideAction(a.id, { decision: 'allow', requestHash: a.requestHash });
  assert.equal((await l.post(`/v1/actions/${a.id}/dispatch`, { destination: 'other' })).status, 400);
  const delivered = await l.post(`/v1/actions/${a.id}/dispatch`); assert.equal(delivered.status, 200); assert.equal((await delivered.json()).state, 'succeeded');
  assert.equal((await (await l.post(`/v1/actions/${a.id}/dispatch`)).json()).state, 'succeeded'); assert.equal(readFileSync(join(l.fixtures, 'notes.txt'), 'utf8'), 'once\n');
  const renamed = await l.app().request(`/v1/devices/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed Mac' }) }); assert.equal(renamed.status, 200);
  await l.stop(child); await l.restart(); assert.equal(l.services.devicesHttp!.get(id).paired, true); assert.equal(l.services.devicesHttp!.get(id).presence, 'stale'); assert.equal(l.services.devicesHttp!.get(id).name, 'Renamed Mac');
  child = l.child(); await until(() => l.services.devicesHttp!.get(id).presence === 'online');
  const revoked = await l.post(`/v1/devices/${id}/revoke`); assert.equal(revoked.status, 200); assert.equal((await revoked.json()).paired, false);
  assert.equal(l.services.devicesHttp!.get(id).presence, 'revoked');
  assert.throws(() => l.services.devicesAdmin.grant({ botId: a.request.botId, tool: FILE_APPEND, destination: id, policy: 'allow' }), HostError);
  await until(() => child.exitCode !== null || child.signalCode !== null); await l.restart(); assert.equal(l.services.devicesHttp!.get(id).paired, false);
  const client = new DeviceClient(l.peer, l.trust()); await assert.rejects(client.post('device/poll', { deviceId: id, installationId: l.services.store.hostId, receipts: [] }, 1000));
  assert.equal(readFileSync(join(l.fixtures, 'notes.txt'), 'utf8'), 'once\n');
});

test('held child effect becomes unknown once; replay never redispatches even after late receipt', { timeout: 30000 }, async t => {
  const l = await lab(t, 1000), id = await l.pair();
  const client = new DeviceClient(l.peer, l.trust()); await client.post('device/poll', { deviceId: id, installationId: l.services.store.hostId, receipts: [] }, 1000);
  const a = l.action(id); const child = l.child(true); await until(() => existsSync(join(l.fixtures, 'peer-ready')));
  const request = l.post(`/v1/actions/${a.id}/dispatch`); await until(() => l.services.store.getAction(a.id).state === 'running'); writeFileSync(join(l.fixtures, 'peer-start'), 'synthetic');
  await until(() => existsSync(join(l.fixtures, 'entered')));
  assert.equal((await (await request).json()).state, 'unknown'); assert.equal(readFileSync(join(l.fixtures, 'notes.txt'), 'utf8'), '', 'no append has occurred before the held effect is released');
  assert.equal((await (await l.post(`/v1/actions/${a.id}/dispatch`)).json()).state, 'unknown');
  writeFileSync(join(l.fixtures, 'release'), 'release'); await until(() => child.exitCode !== null); assert.equal(child.exitCode, 0);
  assert.equal(readFileSync(join(l.fixtures, 'notes.txt'), 'utf8'), 'once\n'); assert.equal(l.services.store.getAction(a.id).state, 'unknown');
  assert.equal((await (await l.post(`/v1/actions/${a.id}/dispatch`)).json()).state, 'unknown'); assert.equal(readFileSync(join(l.fixtures, 'notes.txt'), 'utf8'), 'once\n');
});

test('shutdown finalizes queued action before canonical writer release and permanently stops admission', async t => {
  const l = await lab(t), id = await l.pair(); const client = new DeviceClient(l.peer, l.trust());
  await client.post('device/poll', { deviceId: id, installationId: l.services.store.hostId, receipts: [] }, 1000);
  const a = l.action(id), retained = l.services.devicesAdmin, request = l.post(`/v1/actions/${a.id}/dispatch`);
  await until(() => l.services.store.getAction(a.id).state === 'running');
  assert.throws(() => new HostStore({ dataDir: join(l.root, 'host') }), locked);
  const original = l.services.store.close.bind(l.services.store); let closed = 0;
  l.services.store.close = () => { assert.equal(l.services.store.getAction(a.id).state, 'unknown'); assert.equal(l.services.devicesHttp!.status().pendingDispatches, 0); closed++; original(); };
  const closing = l.services.shutdown({ graceMs: 3000 }); assert.throws(() => retained.pendingClaims(), HostError);
  await closing; assert.equal(closed, 1); assert.equal((await (await request).json()).state, 'unknown'); await l.services.shutdown(); assert.equal(closed, 1);
  const reopened = new HostStore({ dataDir: join(l.root, 'host') }); assert.equal(reopened.getAction(a.id).state, 'unknown'); reopened.close();
});

test('rejected device cleanup is cached and quarantines writer without reopening admin', async t => {
  const l = await lab(t); const original = DeviceServices.prototype.close; let calls = 0;
  DeviceServices.prototype.close = async function () { calls++; await original.call(this); throw Error('synthetic_cleanup_rejection'); };
  try {
    await assert.rejects(l.services.shutdown({ graceMs: 2000 })); await assert.rejects(l.services.shutdown({ graceMs: 2000 }));
    assert.equal(calls, 1); assert.throws(() => new HostStore({ dataDir: join(l.root, 'host') }), locked); assert.throws(() => l.services.devicesAdmin, HostError);
  } finally { DeviceServices.prototype.close = original; /* zero effects and listener/registry positively closed; fixture process-ending cleanup */ l.services.store.close(); l.quarantineTeardown(); }
  // Avoid a teardown retry of deliberately permanent quarantine, already asserted above.
  t.after(() => {});
});

test('authenticated presence expires and pin rotation cannot inherit prior online observation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dx-presence-')); chmodSync(root, 0o700); let offset = 0;
  const store = new HostStore({ dataDir: join(root, 'host'), deviceTtlMs: 500, clock: () => Date.now() + offset });
  const host = generateSyntheticIdentity(join(root, 'host-id'), 'host'), first = generateSyntheticIdentity(join(root, 'first-id'), 'first'), second = generateSyntheticIdentity(join(root, 'second-id'), 'second');
  const service = new DeviceServices(store, { identity: host, pollWaitMs: 50, port: 0 }); const url = await service.start();
  t.after(async () => { await service.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const trust = { hostUrl: url, hostCertPem: host.certPem, hostFingerprint: host.fingerprint };
  const offer = service.admin.pairingBundle({ kind: 'pair' });
  const paired = pairDevice({ dataDir: join(root, 'peer'), identity: first, trust, offerId: offer.offerId, code: offer.code, name: 'Mac', capabilities: [FILE_APPEND], pollIntervalMs: 10 });
  await until(() => service.admin.pendingClaims().length === 1); const id = service.admin.approveClaim(service.admin.pendingClaims()[0]!.claimId).deviceId; await paired;
  const client = new DeviceClient(first, trust); await client.post('device/poll', { deviceId: id, installationId: store.hostId, receipts: [] }, 1000); assert.equal(service.http.get(id).presence, 'online');
  offset += 501; assert.equal(service.http.get(id).presence, 'stale');
  await client.post('device/poll', { deviceId: id, installationId: store.hostId, receipts: [] }, 1000); assert.equal(service.http.get(id).presence, 'online');
  const rotation = service.admin.pairingBundle({ kind: 'rotate', deviceId: id });
  const next = pairDevice({ dataDir: join(root, 'next-peer'), identity: second, trust, offerId: rotation.offerId, code: rotation.code, name: 'Mac', capabilities: [FILE_APPEND], pollIntervalMs: 10 });
  await until(() => service.admin.pendingClaims().length === 1); service.admin.approveClaim(service.admin.pendingClaims()[0]!.claimId); await next;
  assert.equal(service.http.get(id).presence, 'stale'); await assert.rejects(client.post('device/poll', { deviceId: id, installationId: store.hostId, receipts: [] }, 1000));
  await new DeviceClient(second, trust).post('device/poll', { deviceId: id, installationId: store.hostId, receipts: [] }, 1000); assert.equal(service.http.get(id).presence, 'online');
});

test('failed runtime drain retains writer and permanently closes retained device admission until positive retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dx-device-runtime-')); const identity = generateSyntheticIdentity(join(root, 'identity'), 'host');
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let closeEntered = false;
  const services = new HostServices({ dataDir: join(root, 'host'), devices: { identity, pollWaitMs: 50 }, enableEngines: true,
    makeDriver(engine) { return { id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
      async status() { return { engine, installed: true, version: 'synthetic', authentication: 'authenticated', billing: 'subscription' }; },
      async open(threadId, nativeCursor) { return { threadId, nativeCursor: nativeCursor ?? 'fixture' }; },
      async *turn(session, turnId) { yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: {} }; },
      async interrupt() {}, async respondToTool() {}, async close() { closeEntered = true; await held; } }; } });
  t.after(async () => { release(); await services.shutdown({ graceMs: 3000 }); rmSync(root, { recursive: true, force: true }); });
  await services.startDevices(); const admin = services.devicesAdmin;
  const bot = services.store.createBot({ name: 'Fixture', profileId: 'work', engine: 'claude' }), thread = services.store.createThread(bot.id);
  const turn = services.runtime!.startTurn(thread.id, { clientRequestId: 'fixture', content: 'synthetic' }); await services.runtime!.waitForTurn(turn.turn.id);
  await assert.rejects(services.shutdown({ graceMs: 10 })); assert.equal(closeEntered, true);
  assert.throws(() => admin.pairingBundle({ kind: 'pair' }), HostError); assert.throws(() => services.devicesAdmin, HostError);
  assert.throws(() => services.devicesHttp!.list(), HostError); assert.throws(() => new HostStore({ dataDir: join(root, 'host') }), locked);
  release(); await services.shutdown({ graceMs: 3000 }); const reopened = new HostStore({ dataDir: join(root, 'host') }); reopened.close();
});
