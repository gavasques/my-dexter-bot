import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { HostError, ShutdownIncompleteError } from "@dexter/hub";
import {checkMcpEgressPolicy} from "@dexter/connectors";
import { createHostApp } from "@dexter/hub/http";
import { readHubIdentity, readSourceAuthority, OperationsError } from "@dexter/operations";
import { planHostStartup, type HostStartupInput } from "./host-startup.js";
import { connectionsConfigurationHttpPort } from "./connections-configuration.js";
import { OperatorSealedCustody, readOperatorPrivateFd, SealedCustodyError } from "./operator-sealed-custody.js";
import { openOperatorSealedHost } from "./operator-sealed-host.js";
import type { HostServices } from "./host-services.js";
import { assertBrowserUsePrivatePipe, bindBrowserUsePrivateInput, readBrowserUseUnlockFrame } from "./browser-use-private-input.js";

/** Trusted-source dependencies only (never reachable through public flags, env or module paths). */
export interface OperatorHostDependencies {
  write(line: string): void;
  /** Signal source; the shipped executable passes `process`. */
  signals: { on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown; off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown };
  /** Optional ordered lifecycle trace for synthetic proofs. Never carries paths, errors or secrets. */
  trace?(phase: "admission_cut" | "http_closed" | "host_drained" | "custody_closed" | "custody_retained"): void;
  shutdownGraceMs?: number;
  /** Referenced process lifetime held from writer-possible until safe completion; default is a referenced interval. */
  keepAlive?(): { release(): void };
  /** Trusted-source seam for synthetic retention proofs only; the executable never passes it. */
  open?: typeof openOperatorSealedHost;
  /** Observer of the retained owner (synthetic proofs). Called once when a quarantine is entered. */
  retained?(quarantine: OperatorHostQuarantine): void;
}

/** Explicit retained owner: custody (and the host handle when one exists) for reconciliation. Never closed, locked or
 * retried by the launcher; it stays referenced by the installed signal handlers plus the referenced lifetime. */
export interface OperatorHostQuarantine {
  readonly state: "startup_uncertain" | "shutdown_failed";
  readonly custody: OperatorSealedCustody;
  readonly host?: HostServices;
}

/** Process-lifetime strong references to retained owners; entries are never removed by the launcher. */
const RETAINED = new Set<OperatorHostQuarantine>();
const referencedLifetime = (): { release(): void } => { const timer = setInterval(() => {}, 2 ** 30); return { release: () => clearInterval(timer) }; };

const OPTIONS = {
  "data-dir": { type: "string" }, port: { type: "string" }, file: { type: "string" },
  installation: { type: "string" }, owner: { type: "string" }, device: { type: "string" }, generation: { type: "string" }, "key-id": { type: "string" },
  "password-fd": { type: "string" },
  "browser-use-private-input": { type: "boolean", default: false },
  "enable-engines": { type: "boolean", default: false }, "claude-command": { type: "string" }, "codex-command": { type: "string" },
  "grok-command": { type: "string" }, "muse-command": { type: "string" }, "antigravity-command": { type: "string" },
  "enable-bot-delegation": { type: "boolean", default: false }, "enable-mcp": { type: "boolean", default: false }, "enable-device-tools": { type: "boolean", default: false }, "enable-agenda": { type: "boolean", default: false },
  "mcp-op-command": { type: "string" }, "mcp-vault": { type: "string" }, "mcp-op-account": { type: "string" },
  "mcp-private-origin": { type: "string", multiple: true },
  "device-port": { type: "string" }, "app-client-port": { type: "string" }, "app-client-listen": { type: "string" },
  "app-client-origin": { type: "string" }, "app-client-offer-ttl-seconds": { type: "string" }, "owner-control-socket": { type: "string" },
} as const;

const refuse = (message: string): never => { throw new HostError("invalid_input", message); };
const portOf = (text: string | undefined, what: string): number => {
  if (text === undefined || !/^[0-9]{1,5}$/.test(text) || Number(text) > 65_535) return refuse(`${what} must be an explicit 0–65535.`);
  return Number(text);
};
/** Stable public code only: never a message, path, stack or provider error text. */
function code(error: unknown): string {
  const value = error instanceof SealedCustodyError || error instanceof HostError || error instanceof OperationsError ? error.code : "unavailable";
  return /^[a-z_]{1,40}$/.test(value) ? value : "unavailable";
}

/**
 * Dedicated long-lived operator-unlocked host. Order: parse explicit public flags, read the passphrase from ONE inherited
 * FD (zeroed right after unlock), unlock the EXISTING sealed file, dry-run the same normal preflight, then the static
 * `openOperatorSealedHost` composition (single canonical writer), host-owned listeners, and a loopback development HTTP
 * listener. Shutdown: synchronous admission cut -> own HTTP listener confirmed closed -> host drained (existing
 * ShutdownIncomplete waiting contract) -> custody closed. Uncertain open() or non-waitable shutdown failure enters a
 * quarantine that keeps owner, handlers and lifetime; the returned promise then never settles (no voluntary exit).
 */
export async function runOperatorHost(argv: readonly string[], deps: OperatorHostDependencies): Promise<number> {
  const report = (value: object) => deps.write(JSON.stringify(value));
  let custody: OperatorSealedCustody | undefined;
  let input: HostStartupInput, httpPort: number, privateInput = false;
  try {
    let values: ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS; strict: true; allowPositionals: false }>>["values"];
    try { ({ values } = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false })); } catch { return refuse("Unknown or malformed flag."); }
    const get = (key: "data-dir" | "file" | "installation" | "owner" | "device" | "generation" | "key-id" | "password-fd") => values[key] ?? refuse("Missing required flag.");
    const dataDir = resolve(get("data-dir")); httpPort = portOf(values.port, "Port");
    const generation = get("generation"), fd = get("password-fd");
    if (!/^[0-9]{1,8}$/.test(generation) || !/^[0-9]{1,8}$/.test(fd)) refuse("Invalid numeric flag.");
    privateInput = values["browser-use-private-input"];
    if (privateInput) { if (fd !== "0") refuse("Private input requires the owned launcher pipe."); assertBrowserUsePrivatePipe(); }
    const appPort = values["app-client-port"] === undefined ? undefined : portOf(values["app-client-port"], "App client port");
    if (appPort === undefined && (values["app-client-listen"] !== undefined || values["app-client-origin"] !== undefined
      || values["app-client-offer-ttl-seconds"] !== undefined || values["owner-control-socket"] !== undefined)) refuse("App client options require --app-client-port.");
    const devicePort = values["device-port"] === undefined ? undefined : portOf(values["device-port"], "Device port");
    const ttlText = values["app-client-offer-ttl-seconds"] ?? "600";
    if (!/^[0-9]{1,4}$/.test(ttlText) || Number(ttlText) < 1 || Number(ttlText) > 3600) refuse("Offer TTL must be 1–3600 seconds.");
    const claude = values["claude-command"], codex = values["codex-command"];
    const grok = values["grok-command"], muse = values["muse-command"], antigravity = values["antigravity-command"];
    const opCommand = values["mcp-op-command"], mcpVault = values["mcp-vault"], opAccount = values["mcp-op-account"];
    if(values["mcp-private-origin"]!==undefined&&!values["enable-mcp"])refuse("Private MCP origins require enabled MCP.");
    const nativePlacement=process.platform==="darwin"?"owner_mac" as const:"cloud" as const;
    let privateOrigins:readonly string[]|undefined;
    if(values["mcp-private-origin"]!==undefined)try{privateOrigins=checkMcpEgressPolicy({placement:nativePlacement,privateOrigins:values["mcp-private-origin"]}).privateOrigins;}catch{return refuse("Invalid private MCP origins.");}
    if ((opCommand !== undefined || mcpVault !== undefined || opAccount !== undefined)
      && (!values["enable-mcp"] || !opCommand || !mcpVault)) refuse("Native MCP 1Password requires MCP, an absolute op command and an explicit vault.");
    custody = new OperatorSealedCustody(get("file"), { installationId: get("installation"), ownerId: get("owner"), deviceId: get("device"), generation: Number(generation), keyId: get("key-id") });
    // Synchronous read before any await: the owner-private FD is consumed once, then its owned copy is zeroed.
    const password = privateInput ? readBrowserUseUnlockFrame() : readOperatorPrivateFd(Number(fd));
    try { custody.unlock(password); } finally { password.fill(0); }
    const tls = custody.tlsIdentity();
    // TLS listeners only ever use the unlocked custody identity (the wrapper re-injects the same one).
    input = { route: "production", options: { dataDir, enableEngines: values["enable-engines"], enableMcp: values["enable-mcp"], enableBotDelegation: values["enable-bot-delegation"],
      ...(values["enable-mcp"] ? { nativeMcp: { runsOn:nativePlacement,
        ...(privateOrigins!==undefined?{privateOrigins}:{}),
        ...(opCommand && mcpVault ? { onePassword: { command: opCommand, vault: mcpVault,
          ...(opAccount === undefined ? {} : { account: opAccount }) } } : {}) } } : {}),
      enableDeviceTools: values["enable-device-tools"], enableAgenda: values["enable-agenda"],
      ...([claude, codex, grok, muse, antigravity].some(value => value !== undefined) ? { engineCommands: {
        ...(claude !== undefined ? { claude } : {}), ...(codex !== undefined ? { codex } : {}),
        ...(grok !== undefined ? { grok } : {}), ...(muse !== undefined ? { muse } : {}), ...(antigravity !== undefined ? { antigravity } : {}) } } : {}),
      ...(devicePort !== undefined ? { devices: { identity: tls, port: devicePort } } : {}),
      ...(appPort !== undefined ? { appClients: { identity: tls, port: appPort, offerTtlMs: Number(ttlText) * 1_000,
        ...(values["app-client-listen"] !== undefined ? { listenHost: values["app-client-listen"] } : {}),
        ...(values["app-client-origin"] !== undefined ? { advertisedOrigin: values["app-client-origin"] } : {}) } } : {}),
      ...(values["owner-control-socket"] !== undefined ? { ownerControl: { socketPath: values["owner-control-socket"] } } : {}) } };
    // Preflight without any writer: existing canonical, active installation bound to this custody, and the whole plan.
    const identity = readHubIdentity(dataDir), authority = readSourceAuthority(dataDir), binding = custody.toJSON().binding;
    if (identity.installationId !== binding.installationId || identity.ownerId !== binding.ownerId || authority.state !== "active") throw new SealedCustodyError("authentication_failed");
    planHostStartup(input);
  } catch (error) {
    report({ status: "refused", error: code(error) });
    // No writer was opened (unlock, flags or preflight failure): safe to release the caller-owned custody.
    await custody?.close();
    return 1;
  }
  return ownOperatorHost(custody, input, httpPort, deps, privateInput);
}

async function ownOperatorHost(custody: OperatorSealedCustody, input: HostStartupInput, port: number, deps: OperatorHostDependencies, privateInput: boolean): Promise<number> {
  const report = (value: object) => deps.write(JSON.stringify(value));
  // From here a writer may exist: the launcher owns signal handling and a referenced lifetime until safe completion.
  let phase: "opening" | "running" | "stopping" | "quarantined" | "stopped" = "opening";
  let admitting = true, requested = false, failed = false;
  let host: HostServices | undefined, server: ReturnType<typeof serve> | undefined, stopping: Promise<void> | null = null;
  let browserUseInput: ReturnType<typeof bindBrowserUsePrivateInput> | undefined;
  let settle!: (code: number) => void;
  const finished = new Promise<number>(r => { settle = r; });
  const lifetime = (deps.keepAlive ?? referencedLifetime)();
  // Handlers stay installed through stopping and quarantine, so a repeated real signal never restores the default
  // action. Stopping: the single in-flight flow continues. Quarantine: acknowledged no-op (no close, retry or exit).
  const onSignal = (): void => {
    if (phase === "opening") requested = true;
    else if (phase === "running") void stop();
  };
  deps.signals.on("SIGINT", onSignal); deps.signals.on("SIGTERM", onSignal);
  const enterQuarantine = (state: OperatorHostQuarantine["state"], error: unknown): void => {
    phase = "quarantined";
    const quarantine: OperatorHostQuarantine = Object.freeze({ state, custody, ...(host ? { host } : {}) });
    RETAINED.add(quarantine);
    deps.trace?.("custody_retained");
    report({ status: state, error: code(error), custody: "retained" });
    deps.retained?.(quarantine);
  };

  let composed: ReturnType<typeof openOperatorSealedHost>;
  try { composed = (deps.open ?? openOperatorSealedHost)(custody, input); } catch (error) {
    // No host handle exists, but a writer/quarantined runtime may: nothing local can reconcile it. Retain the owner.
    enterQuarantine("startup_uncertain", error);
    return finished;
  }
  host = composed.host;
  const openHost = host;

  const closeHttp = (): Promise<void> => new Promise<void>(done => {
    if (!server || !server.listening) { done(); return; }
    const s = server;
    s.close(() => done());
    if ("closeIdleConnections" in s) s.closeIdleConnections();
    // Bounded: lingering connections are forcibly closed so the listener close is confirmed before any drain.
    setTimeout(() => { if ("closeAllConnections" in s) s.closeAllConnections(); }, 1_000).unref();
  });
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Synchronous cut (runs before the first await): the HTTP gate refuses every request not yet delegated.
    phase = "stopping"; admitting = false;
    report({ status: "stopping" });
    deps.trace?.("admission_cut");
    await closeHttp();
    deps.trace?.("http_closed");
    try {
      await browserUseInput?.close();
      // Existing `dexter serve` contract: ShutdownIncomplete keeps waiting (writer and custody retained, referenced
      // timer keeps the process alive); any other failure is not retried and enters quarantine below.
      for (let reported = false; ;) {
        try { await openHost.shutdown({ graceMs: deps.shutdownGraceMs ?? 5_000 }); break; } catch (error) {
          if (!(error instanceof ShutdownIncompleteError)) throw error;
          if (!reported) report({ status: "shutdown_incomplete", custody: "retained" });
          reported = true;
          await new Promise<void>(r => setTimeout(r, 250));
        }
      }
      deps.trace?.("host_drained");
      // Host is already closed, so composed.shutdown() only releases custody now.
      await composed.shutdown();
    } catch (error) { enterQuarantine("shutdown_failed", error); return; }
    deps.trace?.("custody_closed");
    phase = "stopped";
    deps.signals.off("SIGINT", onSignal); deps.signals.off("SIGTERM", onSignal); lifetime.release();
    report({ status: "stopped" });
    settle(failed ? 1 : 0);
  })();

  try {
    const deviceUrl = input.options.devices ? await openHost.startDevices() : null;
    const appClientUrl = input.options.appClients ? await openHost.startAppClients() : null;
    const ownerControl = input.options.ownerControl ? await openHost.startOwnerControl() : null;
    const app = createHostApp(openHost.store, { ...(openHost.nativeVoice?{nativeVoice:openHost.nativeVoice}:{}), ...(openHost.runtime ? { runtime: openHost.runtime } : {}), ...(openHost.peersHttp ? { devices: openHost.peersHttp } : {}),
      skills:openHost.skillsHttp,
      botDocuments:openHost.botDocumentsHttp,
      ownerConfiguration:openHost.ownerConfigurationHttp,
      browserUse:openHost.browserUseHttp,
      ...(openHost.automationsHttp?{automations:openHost.automationsHttp}:{}),
      ...(openHost.botDelegation ? { botDelegation: openHost.botDelegation } : {}),
      ...(openHost.localDeviceSetupHttp ? { localDeviceSetup: openHost.localDeviceSetupHttp } : {}),
      ...(openHost.deviceGrantsHttp ? { deviceGrants: openHost.deviceGrantsHttp } : {}), ...(openHost.nativeMcpHttp ? { mcp: openHost.nativeMcpHttp } : {}),
      // Output folders on this host's own storage (the VPS disk when this is the VPS); owner loopback here.
      outputFiles: openHost.outputFilesHttp,
      // Existing connections port of the same HostServices: without a trusted provider it stays `unconfigured`.
      connections: openHost.connectionsHttp,
      connectionWorkflows:openHost.connectionWorkflows,
      // Owner-private service configuration of the same host: this embedding has no app private channel (honest
      // `private_channel_unavailable`); a provider it injected reads `configured_externally` and owner saves are refused.
      connectionsConfiguration: connectionsConfigurationHttpPort({ ledger: () => openHost.connectionsConfigurationLedger,
        identity: () => ({ hostId: openHost.store.hostId, ownerId: openHost.store.ownerId }),
        environment: { channel: false, mcpEngines: input.options.enableMcp === true && input.options.enableEngines === true,
          exclusiveUpstream: input.options.enableManagedApps === true },
        composition: () => { const origin = openHost.connectionsServiceOrigin; return origin === null ? null : { source: "external" as const, origin }; },
        custody: null }),
      // Owner pairing offers of this host's app-client channel (owner loopback here); `unconfigured` without it.
      ownerPairingOffers: openHost.ownerPairingOffersHttp });
    // Admission gate checked synchronously per request: after the cut nothing new reaches the app, even on a socket
    // admitted earlier; handlers already delegated finish under the listener-close + host-drain contract.
    const gatedFetch = (...args: Parameters<typeof app.fetch>) => admitting ? app.fetch(...args)
      : new Response(JSON.stringify({ error: "host_stopping" }), { status: 503, headers: { "content-type": "application/json", connection: "close" } });
    const address = await new Promise<AddressInfo>((ready, rejected) => {
      // Development HTTP is loopback-only on the explicit port; there is no remote handler or listen flag for it.
      server = serve({ fetch: gatedFetch, hostname: "127.0.0.1", port }, info => ready(info));
      server.once("error", rejected);
    });
    server!.on("error", () => { report({ status: "listener_failed" }); failed = true; void stop(); });
    const fingerprint = openHost.peersHttp ? input.options.appClients?.identity.fingerprint ?? input.options.devices?.identity.fingerprint : undefined;
    if (privateInput) browserUseInput = bindBrowserUsePrivateInput(process.stdin, openHost.store.hostId, openHost.browserUseKeyVault, deps.write);
    if(!requested)openHost.startAgenda();
    report({ status: "ready", mode: "operator-sealed-local", url: `http://127.0.0.1:${address.port}`, hostId:openHost.store.hostId,
      custody: { kind: "operator_sealed_exportable", storage: "software", exportable: true, physicalCustodyVerified: false },
      engineExecution: openHost.runtime ? "enabled" : "disabled", mcpGateway: openHost.gateway ? "enabled" : "disabled",
      deviceTurnTools: input.options.enableDeviceTools ? "enabled" : "disabled", agenda: input.options.enableAgenda ? "enabled" : "disabled",
      deviceChannel: deviceUrl ? { status: "listening", url: deviceUrl } : { status: "unconfigured" },
      appClientChannel: appClientUrl ? { status: "listening", url: appClientUrl } : { status: "unconfigured" },
      ownerControl: ownerControl ? { status: "listening" } : { status: "unconfigured" },
      ...(fingerprint ? { tlsFingerprint: fingerprint } : {}),
      trustedProviders: { relay: "unconfigured", relayRecovery: "unconfigured", managedApps: "unconfigured" } });
  } catch (error) {
    // Host is open: never close custody directly; run the same ordered shutdown (quarantine on uncertainty).
    report({ status: "startup_failed", error: code(error) });
    failed = true; requested = true;
  }
  phase = "running";
  if (requested) void stop();
  return finished;
}
