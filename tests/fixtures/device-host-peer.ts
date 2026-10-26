// Synthetic held-effect peer only. Reads a private test config; no engine, Keychain or user files.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MacDeviceDaemon, createFixtureHandlers, FILE_APPEND } from "@dexter/devices";
import { receiveMemoryIdentity } from "./device-memory-custody.js";
const identity = await receiveMemoryIdentity();
const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  dataDir: string; identityDir: string; fixtureRoot: string; hostUrl: string; hostFingerprint: string; hostCertPath: string;
};
const daemon = new MacDeviceDaemon({ dataDir: config.dataDir, identity,
  trust: { hostUrl: config.hostUrl, hostFingerprint: config.hostFingerprint, hostCertPem: readFileSync(config.hostCertPath, "utf8") },
  pollTimeoutMs: 5000, requestTimeoutMs: 1000,
  handlers: createFixtureHandlers({ root: config.fixtureRoot, enable: [FILE_APPEND], beforeEffect: async () => {
    writeFileSync(join(config.fixtureRoot, "entered"), "synthetic");
    const deadline = Date.now() + 15000;
    while (!existsSync(join(config.fixtureRoot, "release"))) {
      if (Date.now() >= deadline) throw Error("fixture_gate_timeout");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } }),
});
writeFileSync(join(config.fixtureRoot, "peer-ready"), "synthetic");
const startupDeadline = Date.now() + 15000;
while (!existsSync(join(config.fixtureRoot, "peer-start"))) {
  if (Date.now() >= startupDeadline) throw Error("fixture_start_timeout");
  await new Promise(resolve => setTimeout(resolve, 5));
}
try { const result = await daemon.runOnce(); await daemon.stop(); process.stdout.write(JSON.stringify({ event: "done", jobs: result.jobs }) + "\n"); }
catch { await daemon.stop(); process.stdout.write(JSON.stringify({ event: "failed" }) + "\n"); process.exitCode = 1; }
