// Test-only separate process: private TLS bytes arrive over bounded anonymous FD3; stdin remains the admin pipe.
import { createInterface } from "node:readline";
import { RelayStore, type DevicePin } from "@dexter/relay";
import { RelayService } from "../../packages/relay-service/src/index.js";
import { readRelayMemoryRecord } from "./relay-memory-ipc.js";

const record = readRelayMemoryRecord(3);
let config: { dataDir: string; ownerId: string; installationId: string; pins: DevicePin[] };
try { config = JSON.parse(record.config.toString("utf8")) as typeof config; }
catch (error) { record.config.fill(0); record.key.fill(0); record.cert.fill(0); throw error; }
record.config.fill(0);
const send = (line: object): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };
let store: RelayStore | undefined, service: RelayService | undefined;
try {
  store = new RelayStore({ dataDir: config.dataDir, ownerId: config.ownerId, installationId: config.installationId });
  for (const pin of config.pins) store.registerDevice(pin);
  service = await RelayService.start({ store: { borrow: store }, tls: { key: record.key, cert: record.cert }, host: "127.0.0.1", port: 0 });
} catch (error) {
  try { store?.close(); } catch { /* preserve the startup error */ }
  throw error;
} finally {
  record.key.fill(0);
  record.cert.fill(0);
}
if (!store || !service) throw new Error("relay_child_start_failed");
send({ event: "listening", port: service.address.port });
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line) as { op: string; deviceId?: string; pin?: DevicePin };
  try {
    if (command.op === "revoke") { store.revokeDevice(command.deviceId!); send({ ok: true }); }
    else if (command.op === "register") { store.registerDevice(command.pin); send({ ok: true }); }
    else if (command.op === "status") send({ service: service.status(), store: store.status() });
    else if (command.op === "close") void service.close().then(() => { store.close(); send({ event: "closed" }); process.exit(0); });
  } catch (e) { send({ error: (e as { code?: string }).code ?? "unknown" }); }
});
