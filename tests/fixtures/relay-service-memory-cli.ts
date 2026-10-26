// Test-only launcher of the REAL relay-service CLI (`runCli`: same config parser, RelayStore, pin registration, listener
// and signal lifecycle as bin.js) for a separate OS process. The TLS key/cert arrive once over the inherited IPC channel
// and stay in this process's memory: no key file exists. The trusted embedding seam is not a CLI flag or env fallback.
import { runCli } from "../../packages/relay-service/src/cli.js";

process.once("message", (value: { key: string; cert: string }) => {
  const key = Buffer.from(value.key), cert = Buffer.from(value.cert);
  process.disconnect();
  void runCli(process.argv.slice(2), { tls: () => ({ key, cert }) });
});
