// Owned ephemeral request-binding fixture. Count TCP admissions as well as the existing TLS HTTP count.
// No production implementation changes; the existing pinned TLS fixture remains the actual peer.
import https from 'node:https';
import fs from 'node:fs';
const root = process.argv[2];
fs.writeFileSync(root + '/connections.txt', '0', { mode: 0o600 });
let connections = 0;
const createServer = https.createServer;
https.createServer = (...args) => {
  const server = createServer(...args);
  server.on('connection', () => {
    connections++;
    fs.writeFileSync(root + '/connections.txt', String(connections), { mode: 0o600 });
  });
  return server;
};
await import('./tls-host.mjs');
