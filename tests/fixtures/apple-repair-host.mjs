// Owned laboratory controls only. All pairing and enrollment use canonical HostServices APIs.
// No agent/executor is enrolled, no engine runs, and private TLS material remains in memory.
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createAppleFixtureTLS } from '../../apps/apple/Tests/Fixtures/memory-tls.mjs';
let httpRequests = 0;
const original = https.createServer;
https.createServer = function(...args) {
  const server = original.apply(this, args);
  server.on('request', () => { httpRequests++; });
  return server;
};
syncBuiltinESMExports();
const [root, composition] = process.argv.slice(2);
if (!root?.startsWith('/private/tmp/') || !composition?.startsWith('/private/tmp/')) throw new Error('private laboratory required');
const { HostServices } = await import(pathToFileURL(join(composition, 'packages/cli/dist/host-services.js')));
const { HostStore } = await import(pathToFileURL(join(composition, 'packages/hub/dist/index.js')));
const material = await createAppleFixtureTLS({ name: 'synthetic-apple-repair', composition });
const options = { dataDir: join(root, 'store'), appClients: { identity: material.identity, listenHost: '127.0.0.1', port: 0 } };
const services = new HostServices(options);
await services.startAppClients();
const bot = services.store.createBot({ name: 'Preserved synthetic bot', profileId: 'synthetic_repair_profile', engine: 'codex' });
// Explicit trusted owner setup, before either client exists. Revoke must not erase these grants.
services.store.setGrant({ botId: bot.id, tool: 'synthetic.notice', destination: 'host', policy: 'deny' });
services.store.setGrant({ botId: bot.id, tool: 'synthetic.notice', destination: 'synthetic_executor', policy: 'allow' });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const offer = scopes => services.appClientsAdmin.pairingBundle({ kind: 'pair', role: 'client-mac', scopes });
const readRows = (file, sql) => {
  const db = new DatabaseSync(join(options.dataDir, file), { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};
const inspect = () => ({
  pid: process.pid, httpRequests,
  preserved: {
    hostID: services.store.hostId, ownerID: services.store.ownerId,
    profiles: readRows('dexter.sqlite', 'SELECT * FROM profiles ORDER BY id'),
    bots: services.store.listBots(),
    grants: readRows('dexter.sqlite', 'SELECT * FROM grants ORDER BY id'),
  },
  devices: services.store.listDevices(),
  bindings: readRows('app-clients.sqlite', 'SELECT * FROM client_bindings ORDER BY device_id'),
  certificates: readRows('app-clients.sqlite', 'SELECT * FROM client_certs ORDER BY fp'),
  claims: readRows('app-clients.sqlite', 'SELECT id, status, role, scopes, client_fp FROM claims ORDER BY id'),
  pendingClaims: services.appClientsAdmin.pendingClaims(),
});
send({ bundle: offer(['approvals.read', 'chat.read', 'chat.write', 'devices.manage', 'devices.read']), observation: inspect() });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let exiting = false;
async function cleanup() { if (exiting) return; exiting = true; await services.shutdown({ graceMs: 3000 }); input.close(); }
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
for await (const line of input) {
  try {
    const command = JSON.parse(line);
    if (command.op === 'inspect') send(inspect());
    else if (command.op === 'offer') send({ bundle: offer(['approvals.read', 'chat.read', 'devices.read']) });
    else if (command.op === 'approve') {
      const claim = services.appClientsAdmin.pendingClaims().find(x => x.claimId === command.claimID);
      // Intended scopes and exact claimed identity reviewed out of band by synthetic trusted owner.
      if (!claim || JSON.stringify(claim.scopes) !== command.scopes || claim.clientFingerprint !== command.fingerprint) throw new Error('owner intent mismatch');
      send(services.appClientsAdmin.approveClaim(claim.claimId));
    } else if (command.op === 'stop') {
      await cleanup(); const reopened = new HostStore({ dataDir: options.dataDir }); reopened.close();
      send({ writerReleased: true }); break;
    } else throw new Error('closed laboratory command');
  } catch { send({ fixtureError: true }); }
}
await cleanup();
