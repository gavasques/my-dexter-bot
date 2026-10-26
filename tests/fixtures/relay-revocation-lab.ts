// Private helper for the relay-service sender-revocation lab. Launches the REAL relay-service CLI (`runCli`: same config parser,
// RelayStore, pin registration, revocation, listener and signal lifecycle) in a SEPARATE OS process through the existing memory
// launcher: the TLS key/cert cross once over the inherited IPC channel and no key file exists. Config files hold public data only.
import { fork } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { TlsIdentity } from "@dexter/devices";
import { PinnedRelayTransport } from "@dexter/relay-service";
import { defer } from "./relay-recovery-lab.js";

export interface RevocationService { port: number; transport(timeoutMs?: number): PinnedRelayTransport; stop(): Promise<{ code: number | null; events: string[] }> }
export interface Refusal { code: number | null; stdout: string; error: string }
const SPAWN_DEADLINE_MS = 15_000;
let counter = 0;
/** Writes a public 0600 config next to the lab and forks the memory launcher; resolves on `listening` or on exit. */
async function launch(t: TestContext, dir: string, tls: TlsIdentity, config: Record<string, unknown>): Promise<RevocationService | Refusal> {
  const path = join(dir, `revoke-${++counter}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, host: "127.0.0.1", port: 0, ...config }), { mode: 0o600, flag: "wx" });
  const child = fork(new URL("./relay-service-memory-cli.js", import.meta.url), ["--config", path], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "", exited = false;
  child.stdout!.on("data", b => { stdout += String(b); }); child.stderr!.on("data", b => { stderr += String(b); });
  const exit = new Promise<number | null>(resolve => child.once("exit", c => { exited = true; resolve(c); }));
  defer(t, async () => { if (!exited) { child.kill("SIGKILL"); await exit; } });
  child.send({ key: tls.keyPem, cert: tls.certPem });
  const until = Date.now() + SPAWN_DEADLINE_MS;
  while (!stdout.includes("\n") && !exited) { if (Date.now() > until) { child.kill("SIGKILL"); await exit; throw new Error("relay service neither listened nor exited"); } await new Promise(r => setTimeout(r, 10)); }
  if (exited) { const code = await exit; return { code, stdout, error: stderr.trim() ? (JSON.parse(stderr.trim().split("\n")[0]!) as { error: string }).error : "" }; }
  const ready = JSON.parse(stdout.split("\n")[0]!) as { event: string; port: number };
  if (ready.event !== "listening") throw new Error("unexpected first event");
  const leaf = createHash("sha256").update(new X509Certificate(tls.certPem).raw).digest("base64");
  return { port: ready.port,
    transport: (timeoutMs = 3000) => new PinnedRelayTransport({ host: "127.0.0.1", port: ready.port, servername: "localhost", ca: tls.certPem, leafSha256: leaf, timeoutMs }),
    stop: async () => { child.kill("SIGTERM"); const c = await exit; return { code: c, events: stdout.split("\n").filter(Boolean).map(l => (JSON.parse(l) as { event: string }).event) }; } };
}
export async function startService(t: TestContext, dir: string, tls: TlsIdentity, config: Record<string, unknown>): Promise<RevocationService> {
  const r = await launch(t, dir, tls, config);
  if ("stop" in r) return r;
  throw new Error(`relay service refused: ${r.error}`);
}
export async function refusedService(t: TestContext, dir: string, tls: TlsIdentity, config: Record<string, unknown>): Promise<Refusal> {
  const r = await launch(t, dir, tls, config);
  if ("stop" in r) { await r.stop(); throw new Error("relay service unexpectedly listened"); }
  return r;
}
