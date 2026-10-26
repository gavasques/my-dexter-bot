// Owned synthetic HTTP + TLS listeners and a temporary store. Public metadata only; no identity helper,
// Keychain, account, inference, pairing request, real user store or configured product port.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { serve } from '@hono/node-server';
import { HostStore } from '@dexter/hub';
import { createHostApp } from '@dexter/hub/http';
import { createLabTlsIdentity } from '@dexter/devices';
import { DeviceServices } from '../../packages/cli/dist/device-services.js';
import { localDeviceSetupPort } from '../../packages/cli/dist/local-device-setup-port.js';

const root = process.argv[2];
assert.ok(root?.startsWith('/'));
const store = new HostStore({ dataDir: join(root, 'host') });
const { identity } = createLabTlsIdentity({ profile: 'device', name: 'dexter-synthetic-swift-connection' });
const device = new DeviceServices(store, { identity, port: 0, pollWaitMs: 50 });
const hostUrl = await device.start();
const port = localDeviceSetupPort(store, () => device.admin);
const app = createHostApp(store, { localDeviceSetup: port });
let redirect = false, metadataRequests = 0, redirectTargetRequests = 0, stopping = false;
const server = serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/sink') { redirectTargetRequests++; return Response.json({}); }
  if (url.pathname === '/v1/local-mac-agent/connection') {
    metadataRequests++; assert.equal(request.method, 'GET'); assert.equal(url.search, '');
    if (redirect) return new Response(null, { status: 302, headers: { Location: url.origin + '/sink' } });
  }
  return app.fetch(request);
} });
await new Promise(resolve => server.once('listening', resolve));
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
write({ port: server.address().port, installationId: store.hostId, hostUrl, hostFingerprint: identity.fingerprint });
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(deadline);
  await new Promise(resolve => server.close(resolve)); await device.close(); store.close();
}
const deadline = setTimeout(() => { void stop().finally(() => process.exit(1)); }, 20000);
const lines = createInterface({ input: process.stdin, terminal: false });
for await (const command of lines) {
  if (command === 'redirect') { redirect = true; write({ redirect: true }); }
  else if (command === 'finish') {
    const db = new DatabaseSync(join(root, 'host', 'devices.sqlite'), { readOnly: true });
    const count = name => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n);
    const proof = { metadataRequests, redirectTargetRequests, offers: count('offers'), claims: count('claims'),
      devices: store.listDevices().length, grants: store.summary().counts.grants };
    db.close(); await stop(); write(proof); process.exit(0);
  } else throw new Error('unknown fixture command');
}
await stop();
