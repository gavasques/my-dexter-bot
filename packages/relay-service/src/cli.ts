import { RelayStore, type DevicePin } from "@dexter/relay";
import { RelayService } from "./server.js";
import { readPrivateFile } from "./files.js";
import { closedParse } from "./wire.js";

/**
 * Lab operator entry (`bin.js --config /abs/private.json`). The trusted config names a private data dir,
 * loopback host/port, private PEM files and optional public pins approved out-of-band. It never creates TLS
 * material, deploys, provisions or opens admin routes. Output is fixed JSON events/codes only.
 */
const CONFIG_KEYS = ["version", "dataDir", "ownerId", "installationId", "host", "port", "tlsKeyFile", "tlsCertFile", "pins", "revokedDevices"];
const DEVICE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const out = (line: object): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };
const fail = (code: string, exit = 1): never => { process.stderr.write(`${JSON.stringify({ error: code })}\n`); process.exit(exit); };
/** Upper bound for a requested stop (service drain deadline is 5 s); past it the process exits with a fixed code. */
const STOP_DEADLINE_MS = 15_000;

class CliFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = "CliFailure"; }
}

/**
 * Everything the CLI opened. It owns the borrowed store and closes it exactly once, only after startup rolled
 * back or the service drained. `stop()` is cached, so repeated signals share one finite shutdown.
 */
class Lifecycle {
  store: RelayStore | null = null;
  service: RelayService | null = null;
  key: Buffer | null = null;
  startup: Promise<void> = Promise.resolve();
  #storeClosed = false;
  #stopping: Promise<number> | null = null;
  get stopping(): boolean { return this.#stopping !== null; }
  wipe(): void { this.key?.fill(0); this.key = null; }
  closeStore(): boolean {
    if (!this.store || this.#storeClosed) return true;
    this.#storeClosed = true;
    try { this.store.close(); return true; } catch { return false; }
  }
  stop(): Promise<number> {
    return this.#stopping ??= (async () => {
      const guard = setTimeout(() => fail("stop_timeout", 70), STOP_DEADLINE_MS);
      try {
        // A stop requested during startup waits for that (finite) startup to settle, then tears down what exists.
        const started = await this.startup.then(() => true, () => false);
        let code = started ? 0 : 1;
        if (this.service) try { await this.service.close(); } catch { code = 70; }
        if (!this.closeStore()) code = 70;
        this.wipe();
        return code;
      } finally { clearTimeout(guard); }
    })();
  }
}


/**
 * Explicit operator revocation list (`revokedDevices`: at most 64 exact device IDs, public data only). Pure validation, run before
 * any file, store or listener: wrong type, malformed or duplicate ID, or an ID that the same config also pins is `config_invalid`.
 */
function revocations(config: Record<string, unknown>): readonly string[] {
  const list = config.revokedDevices;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 64 || list.some(v => typeof v !== "string" || !DEVICE_ID.test(v)) || new Set<unknown>(list).size !== list.length) throw new CliFailure("config_invalid");
  const pinned = new Set<unknown>(((config.pins ?? []) as unknown[]).map(p => (p !== null && typeof p === "object" ? (p as { deviceId?: unknown }).deviceId : undefined)));
  if (list.some(v => pinned.has(v))) throw new CliFailure("config_invalid");
  return list as string[];
}

/**
 * Trusted in-process embedding seam (NOT argv/env/config): an embedding that already holds the TLS key in memory (e.g.
 * received over an inherited IPC channel) supplies it here instead of naming key/cert files. The config parser, store,
 * pin registration, listener and lifecycle are the same; with this seam the config must NOT name TLS files. The
 * distributed `bin.js` never passes it, so the default path keeps requiring private key/cert files.
 */
export interface TrustedCliEmbedding { tls: () => { key: Buffer; cert: Buffer } }

/** Runs until SIGTERM/SIGINT; exits the process with fixed codes. Signal handlers exist before any async startup. */
export async function runCli(args: readonly string[], embedding?: TrustedCliEmbedding): Promise<void> {
  const life = new Lifecycle();
  const onSignal = (): void => {
    void life.stop().then(code => {
      if (code === 0) { out({ event: "closed" }); process.exit(0); }
      return fail(code === 1 ? "startup_failed" : "close_failed", code);
    });
  };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  life.startup = start(args, life, embedding);
  try { await life.startup; }
  catch (e) {
    life.closeStore(); life.wipe();
    return fail(e instanceof CliFailure ? e.code : "startup_failed");
  }
  if (!life.stopping) out({ event: "listening", host: life.service!.address.host, port: life.service!.address.port });
}

async function start(args: readonly string[], life: Lifecycle, embedding?: TrustedCliEmbedding): Promise<void> {
  if (args.length !== 2 || args[0] !== "--config") throw new CliFailure("usage");
  let config: Record<string, unknown>;
  try { config = closedParse(readPrivateFile(args[1]!, 65_536)); } catch { throw new CliFailure("config_untrusted"); }
  const tlsFiles = embedding ? config.tlsKeyFile === undefined && config.tlsCertFile === undefined : typeof config.tlsKeyFile === "string" && typeof config.tlsCertFile === "string";
  if (Object.keys(config).some(k => !CONFIG_KEYS.includes(k)) || config.version !== 1 || !tlsFiles
    || (config.pins !== undefined && (!Array.isArray(config.pins) || config.pins.length > 64))) throw new CliFailure("config_invalid");
  const revoked = revocations(config);
  let cert: Buffer;
  if (embedding) {
    try { const tls = embedding.tls(); if (!Buffer.isBuffer(tls.key) || !Buffer.isBuffer(tls.cert)) throw new Error(); life.key = tls.key; cert = tls.cert; } catch { throw new CliFailure("tls_unavailable"); }
  } else {
    try { life.key = readPrivateFile(config.tlsKeyFile as string, 65_536); cert = readPrivateFile(config.tlsCertFile as string, 65_536); } catch { throw new CliFailure("tls_file_untrusted"); }
  }
  try { life.store = new RelayStore({ dataDir: config.dataDir as string, ownerId: config.ownerId as string, installationId: config.installationId as string }); }
  catch { throw new CliFailure("store_unavailable"); }
  try {
    for (const pin of (config.pins ?? []) as DevicePin[]) life.store.registerDevice(pin);
    // Owner revocation (store policy, durable tombstone, pending receipts go stale) before the listener exists. An ID the store never
    // pinned is refused, never created or guessed; earlier entries stay revoked, which only narrows authority.
    for (const deviceId of revoked) {
      try { life.store.revokeDevice(deviceId); }
      catch (e) { throw new CliFailure(e instanceof Error && "code" in e && e.code === "forbidden" ? "revocation_unknown" : "startup_failed"); }
    }
    life.service = await RelayService.start({ store: { borrow: life.store }, tls: { key: life.key, cert }, host: config.host as "127.0.0.1", port: config.port as number });
  } catch (e) {
    throw new CliFailure(e instanceof Error && "code" in e && typeof e.code === "string" && /^[a-z_]{1,40}$/.test(e.code) ? e.code : "startup_failed");
  }
  life.wipe();
}
