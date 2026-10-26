#!/usr/bin/env node
import { runAuthorityOwnerCli } from "./owner-authority-maintenance-client.js";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { assertBrowserUsePrivatePipe, bindBrowserUsePrivateInput, readBrowserUseUnlockFrame } from "./browser-use-private-input.js";
import { AppPrivateMcpOAuthCustodyChannel, privateOutputIsOwnedPipe } from "./mcp-oauth-private-custody.js";
import { PrivateChannelMcpOAuthTokenStore, checkMcpEgressPolicy } from "@dexter/connectors";
import { PROTOCOL_VERSION, exportContracts } from "@dexter/contracts";
import { DATABASE_FILE, HostError, HostStore, ConversationRuntime, ShutdownIncompleteError } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import { discoverEngineCatalog } from "@dexter/engines";
import { loadIdentity } from "@dexter/devices";
import { readHubIdentity, readSourceAuthority } from "@dexter/operations";
import { openLocalDeviceCustody } from "./local-device-custody.js";
import { openDesktopAppClientCustody, isTailscaleIPv4 } from "./desktop-app-client-custody.js";
import { type OperatorSealedCustody } from "./operator-sealed-custody.js";
import { readLocalDevicePasswordFd } from "./local-device-password-input.js";
import { type HostServicesOptions } from "./host-services.js";
import { planHostStartup, type HostStartupProviders, type HostStartupPublicOptions } from "./host-startup.js";
import { planConnectionsPrivateStartup } from "./connections-startup.js";
import { connectionsConfigurationHttpPort, withPrivateCustodyStatus, type ConnectionsComposition } from "./connections-configuration.js";
import { OWNER_CLI_USAGE, RELAY_OWNER_CLI_USAGE, runOwnerControlCli, runRelayOwnerCli } from "./owner-control-client.js";

function output(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
/** System fetch captured at load (system trust store): the only network path of the owner-configured connections service. */
const systemFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** Keep this process and its writer alive until all in-flight engine/tool work has settled. */
export async function shutdownRuntime(
  runtime: Pick<ConversationRuntime, "shutdown">,
  report: (message: string) => void = (message) => { process.stderr.write(message + "\n"); },
  options: { graceMs?: number; retryMs?: number } = {},
): Promise<void> {
  let incomplete = false;
  for (;;) {
    try {
      await runtime.shutdown({ graceMs: options.graceMs ?? 5_000 });
      if (incomplete) report("Host shutdown complete; writer released.");
      return;
    } catch (error) {
      if (!(error instanceof ShutdownIncompleteError)) throw error;
      if (!incomplete) report("Host shutdown incomplete; cleanup is not confirmed. Store and writer lease retained.");
      incomplete = true;
      // Referenced timer keeps the owner process alive even if only unresolved promises remain.
      await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, options.retryMs ?? 250));
    }
  }
}

function doctor(dataDir: string): void {
  const databasePath = join(dataDir, DATABASE_FILE);
  let main: Stats;
  try { main = lstatSync(databasePath); } catch {
    output({ status: "not_initialized", dataDir, node: process.version, protocolVersion: PROTOCOL_VERSION });
    return;
  }
  // Known-incomplete main refuses before any SQLite read: an empty or truncated main would let SQLite discard the WAL beside it.
  // lstat only (no descriptor, no symlink follow); a practical refusal, not a guarantee against concurrent truncation or rename.
  if (!main.isFile() || main.size < 512 || main.size % 512 !== 0)
    throw new HostError("conflict", "Canonical database is not a complete regular SQLite file; doctor did not open it.");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row["name"]));
    const counts: Record<string, number> = {};
    for (const name of ["bots", "threads", "messages", "events", "actions", "devices", "turns", "turn_events"]) {
      if (tables.has(name)) counts[name] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()?.["count"]);
    }
    output({ status: "initialized", dataDir, node: process.version, protocolVersion: PROTOCOL_VERSION,
      schema: db.prepare("PRAGMA user_version").get()?.["user_version"], counts,
      engineInference: "not_verified", remotePairing: "not_implemented" });
  } finally { db.close(); }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if(command==="authority") { process.exitCode=await runAuthorityOwnerCli(process.argv.slice(3),{stdout:text=>{process.stdout.write(text);}}); return; }
  if (command === "relay") {
    // Relay owner administration over the running host's private owner socket; never opens a store or custody.
    process.exitCode = await runRelayOwnerCli(process.argv.slice(3), {
      stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); },
      env: { DEXTER_OWNER_CONTROL_SOCKET: process.env["DEXTER_OWNER_CONTROL_SOCKET"] },
    });
    return;
  }
  if (command === "app-client") {
    // Talks to the running host over its private owner socket; never opens the HostStore.
    process.exitCode = await runOwnerControlCli(process.argv.slice(3), {
      stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); },
      env: { DEXTER_OWNER_CONTROL_SOCKET: process.env["DEXTER_OWNER_CONTROL_SOCKET"] },
    });
    return;
  }
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    "data-dir": { type: "string", default: process.env["DEXTER_DATA_DIR"] ?? ".dexter" },
    port: { type: "string", default: "4317" },
    "enable-engines": { type: "boolean", default: false },
    "browser-use-private-input": { type: "boolean", default: false },
    "claude-command": { type: "string" },
    "codex-command": { type: "string" },
    "grok-command": { type: "string" }, "muse-command": { type: "string" }, "antigravity-command": { type: "string" },
    "device-identity-dir": { type: "string" },
    "device-port": { type: "string" },
    "local-device-custody-file": { type: "string" },
    "local-device-custody-action": { type: "string" },
    "local-device-password-fd": { type: "string" },
    "app-client-identity-dir": { type: "string" },
    "app-client-custody-file": { type: "string" },
    "app-client-custody-action": { type: "string" },
    "app-client-expected-host": { type: "string" },
    "app-client-expected-owner": { type: "string" },
    "app-client-port": { type: "string" },
    "app-client-listen": { type: "string" },
    "app-client-origin": { type: "string" },
    "app-client-offer-ttl-seconds": { type: "string" },
    "owner-control-socket": { type: "string" },
    "enable-bot-delegation": { type: "boolean", default: false }, "enable-mcp": { type: "boolean", default: false },
    "mcp-op-command": { type: "string" },
    "mcp-vault": { type: "string" },
    "mcp-op-account": { type: "string" },
    "mcp-private-origin": { type: "string", multiple: true },
    "enable-device-tools": { type: "boolean", default: false },
    "enable-agenda": { type: "boolean", default: false },
    "ai-memory-origin": { type: "string" },
    "ai-memory-lab": { type: "boolean", default: false },
    "ai-memory-owner-exclusive": { type: "boolean", default: false },
  }, strict: true });
  // Operator engine executables configure serve only; never ignored or forwarded to diagnostics such as `engines`.
  const claudeCommand = values["claude-command"], codexCommand = values["codex-command"];
  const grokCommand = values["grok-command"], museCommand = values["muse-command"], antigravityCommand = values["antigravity-command"];
  const explicitEngineCommands = claudeCommand !== undefined || codexCommand !== undefined || grokCommand !== undefined || museCommand !== undefined || antigravityCommand !== undefined;
  if (command !== "serve" && explicitEngineCommands)
    throw new HostError("invalid_input", "Engine command options apply to dexter serve only.");
  const opCommand = values["mcp-op-command"], mcpVault = values["mcp-vault"], opAccount = values["mcp-op-account"];
  if(values["mcp-private-origin"]!==undefined&&(command!=="serve"||!values["enable-mcp"]))throw new HostError("invalid_input","Private MCP origins require serve and enabled MCP.");
  const nativePlacement=process.platform==="darwin"?"owner_mac" as const:"cloud" as const;
  let privateOrigins:readonly string[]|undefined;
  if(values["mcp-private-origin"]!==undefined)try{privateOrigins=checkMcpEgressPolicy({placement:nativePlacement,privateOrigins:values["mcp-private-origin"]}).privateOrigins;}catch{throw new HostError("invalid_input","Invalid private MCP origins.");}
  if ((opCommand !== undefined || mcpVault !== undefined || opAccount !== undefined)
    && (command !== "serve" || !values["enable-mcp"] || !opCommand || !mcpVault))
    throw new HostError("invalid_input", "Native MCP 1Password requires serve, MCP, an absolute op command and an explicit vault.");
  const custodyFile = values["local-device-custody-file"], custodyAction = values["local-device-custody-action"], passwordFd = values["local-device-password-fd"];
  const deviceSealedMode = custodyFile !== undefined || custodyAction !== undefined || passwordFd !== undefined;
  const appCustodyFile = values["app-client-custody-file"], appCustodyAction = values["app-client-custody-action"];
  const appExpectedHost = values["app-client-expected-host"], appExpectedOwner = values["app-client-expected-owner"];
  const appSealedMode = appCustodyFile !== undefined || appCustodyAction !== undefined;
  const sealedMode = deviceSealedMode || appSealedMode;
  const browserUsePrivateInput = values["browser-use-private-input"];
  if (browserUsePrivateInput) {
    if (command !== "serve" || deviceSealedMode && passwordFd !== "0") throw new HostError("invalid_input", "Private input requires the owned launcher pipe.");
    assertBrowserUsePrivatePipe();
  }
  if (deviceSealedMode && (command !== "serve" || !custodyFile || !isAbsolute(custodyFile)
    || !["create", "unlock"].includes(custodyAction ?? "") || !passwordFd || !/^[0-9]{1,8}$/.test(passwordFd)
    || (Number(passwordFd) !== 0 && Number(passwordFd) < 3) || values["device-identity-dir"] !== undefined))
    throw new HostError("invalid_input", "Local device custody requires serve, absolute file, explicit create/unlock and private inherited FIFO FD0 or operator FD >=3; plaintext identity conflicts.");
  if (appSealedMode && (command !== "serve" || !appCustodyFile || !isAbsolute(appCustodyFile)
    || !["create","unlock"].includes(appCustodyAction ?? "") || !browserUsePrivateInput || !privateOutputIsOwnedPipe()
    || !/^[A-Za-z0-9_-]{1,80}$/.test(appExpectedHost ?? "") || !/^[A-Za-z0-9_-]{1,80}$/.test(appExpectedOwner ?? "")
    || !isTailscaleIPv4(values["app-client-listen"]) || values["app-client-identity-dir"] !== undefined
    || values["app-client-origin"] !== undefined || values["owner-control-socket"] !== undefined))
    throw new HostError("invalid_input", "Desktop app custody requires the private launcher pipe, an exact private interface and an explicit create/unlock action.");
  if (!appSealedMode && (appExpectedHost !== undefined || appExpectedOwner !== undefined))
    throw new HostError("invalid_input", "Expected app client identity requires desktop encrypted custody.");
  const dataDir = resolve(values["data-dir"]);
  if (command === "contracts") { output({ protocolVersion: PROTOCOL_VERSION, schemas: exportContracts() }); return; }
  if (command === "doctor") { doctor(dataDir); return; }
  if (command === "engines") {
    output({ engines: await discoverEngineCatalog({probeVersions:true}), inference: "not_requested" });
    return;
  }
  if (command === "help" || command === "--help") {
    process.stdout.write("dexter serve [--data-dir PATH] [--port 4317] [--enable-engines [--claude-command ABS_PATH] [--codex-command ABS_PATH] [--grok-command ABS_PATH] [--muse-command ABS_PATH] [--antigravity-command ABS_PATH]] [--enable-mcp [--mcp-private-origin ORIGIN ...]] [--enable-device-tools] [--enable-agenda] [--device-identity-dir PATH [--device-port N]] [--local-device-custody-file ABS_PATH --local-device-custody-action create|unlock --local-device-password-fd 0|N>=3 [--device-port N]] [--app-client-identity-dir PATH [--app-client-port N] [--app-client-listen IP] [--app-client-origin https://HOST:PORT] [--app-client-offer-ttl-seconds 1..3600] [--owner-control-socket ABS_PATH]] [--ai-memory-origin ORIGIN --ai-memory-owner-exclusive [--ai-memory-lab]]\ndexter doctor [--data-dir PATH]\ndexter engines\ndexter contracts\n" + OWNER_CLI_USAGE + RELAY_OWNER_CLI_USAGE);
    return;
  }
  if (command !== "serve") throw new HostError("invalid_input", "Unknown command. Use dexter help.");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new HostError("invalid_input", "Port must be 0–65535.");
  const identityDir = values["device-identity-dir"], devicePort = Number(values["device-port"] ?? "0");
  if ((!identityDir && !deviceSealedMode && values["device-port"] !== undefined) || !Number.isInteger(devicePort) || devicePort < 0 || devicePort > 65535)
    throw new HostError("invalid_input", "Device port requires a private identity directory or encrypted custody and must be 0–65535.");
  let devices: HostServicesOptions["devices"];
  if (identityDir) {
    try { devices = { identity: loadIdentity(resolve(identityDir)), port: devicePort }; }
    catch { throw new HostError("invalid_input", "Device identity must be supplied in a private directory."); }
  }
  const appIdentityDir = values["app-client-identity-dir"], appPort = Number(values["app-client-port"] ?? "0");
  if (!appIdentityDir && !appSealedMode && (values["app-client-port"] !== undefined || values["app-client-listen"] !== undefined || values["app-client-origin"] !== undefined
    || values["app-client-offer-ttl-seconds"] !== undefined || values["owner-control-socket"] !== undefined))
    throw new HostError("invalid_input", "App client options require a private identity directory.");
  if (!Number.isInteger(appPort) || appPort < 0 || appPort > 65535) throw new HostError("invalid_input", "App client port must be 0–65535.");
  const offerTtlSeconds = Number(values["app-client-offer-ttl-seconds"] ?? "600");
  if (!Number.isInteger(offerTtlSeconds) || offerTtlSeconds < 1 || offerTtlSeconds > 3600) throw new HostError("invalid_input", "Offer TTL must be 1–3600 seconds.");
  let appClients: HostServicesOptions["appClients"];
  if (appIdentityDir) {
    try { appClients = { identity: loadIdentity(resolve(appIdentityDir)), port: appPort, offerTtlMs: offerTtlSeconds * 1_000,
      ...(values["app-client-listen"] ? { listenHost: values["app-client-listen"] } : {}),
      ...(values["app-client-origin"] ? { advertisedOrigin: values["app-client-origin"] } : {}) }; }
    catch { throw new HostError("invalid_input", "App client identity must be supplied in a private directory."); }
  }
  const memoryOrigin = values["ai-memory-origin"];
  if (!memoryOrigin && (values["ai-memory-lab"] || values["ai-memory-owner-exclusive"])) throw new HostError("invalid_input", "ai-memory options require an origin.");
  const memoryUserKey = memoryOrigin && !values["ai-memory-lab"] ? process.env["DEXTER_AI_MEMORY_USER_KEY"] : undefined;
  if (memoryOrigin && !values["ai-memory-lab"] && !memoryUserKey?.startsWith("aim_")) {
    throw new HostError("invalid_input", "An ai-memory user key must be supplied privately in the host environment.");
  }
  if (memoryUserKey) delete process.env["DEXTER_AI_MEMORY_USER_KEY"];
  // Durable native MCP OAuth custody (UX-P1-10) only for the app-owned launcher: private stdin pipe AND private stdout
  // pipe, with MCP. Otherwise tokens stay in memory (volatile) — never a file, env or argv fallback.
  let custodyServices: { store: { hostId: string; ownerId: string }; nativeMcpAdmin: { instancePin(id: string): string } } | undefined;
  const oauthChannel = browserUsePrivateInput && values["enable-mcp"] && privateOutputIsOwnedPipe() ? new AppPrivateMcpOAuthCustodyChannel() : undefined;
  const oauthCustody = oauthChannel ? new PrivateChannelMcpOAuthTokenStore({ channel: oauthChannel,
    scope: () => custodyServices ? { installationId: custodyServices.store.hostId, ownerId: custodyServices.store.ownerId } : null,
    instancePin: (id: string) => { if (!custodyServices) throw new Error("unbound"); return custodyServices.nativeMcpAdmin.instancePin(id); } }) : undefined;
  const custodyProviders = oauthCustody ? { nativeMcpOAuth: { store: oauthCustody } } : undefined;
  // Owner-private connections service (Conectar apps): only the app-launched host (private stdin FIFO + owned stdout
  // pipe) composes it, from the owner's saved metadata of this existing installation; the capability arrives later over
  // that pipe into memory. Without the channel/configuration nothing is composed (honest `unconfigured`).
  const connectionsStartup = planConnectionsPrivateStartup({ dataDir, channel: Boolean(browserUsePrivateInput) && privateOutputIsOwnedPipe(),
    enableMcp: values["enable-mcp"] === true, enableEngines: values["enable-engines"] === true, exclusiveUpstream: false,
    fetch: (url, init) => systemFetch(url, init) });
  const startupProviders: HostStartupProviders | undefined = custodyProviders || connectionsStartup.provider
    ? { ...(custodyProviders ?? {}), ...(connectionsStartup.provider ? { connections: connectionsStartup.provider } : {}) } : undefined;
  // Same validated route as a trusted embedding; the plain executable never supplies relay/managed-app providers.
  const startupOptions: HostStartupPublicOptions = { dataDir, enableEngines: values["enable-engines"],
    ...(explicitEngineCommands ? { engineCommands: {
      ...(claudeCommand !== undefined ? { claude: claudeCommand } : {}), ...(codexCommand !== undefined ? { codex: codexCommand } : {}),
      ...(grokCommand !== undefined ? { grok: grokCommand } : {}), ...(museCommand !== undefined ? { muse: museCommand } : {}),
      ...(antigravityCommand !== undefined ? { antigravity: antigravityCommand } : {}) } } : {}),
    enableMcp: values["enable-mcp"], enableBotDelegation: values["enable-bot-delegation"],
    ...(connectionsStartup.provider ? { enableConnections: true } : {}),
    // Local serve: an empty owner-local native MCP runtime so the Mac UI can add connections. Nothing starts by itself.
    ...(values["enable-mcp"] ? { nativeMcp: { runsOn: nativePlacement,
      ...(privateOrigins!==undefined?{privateOrigins}:{}), ...(oauthCustody ? { oauthCustody: "app_private_channel" as const } : {}),
      ...(opCommand && mcpVault ? { onePassword: { command: opCommand, vault: mcpVault,
        ...(opAccount === undefined ? {} : { account: opAccount }) } } : {}) } } : {}),
    enableDeviceTools: values["enable-device-tools"], enableAgenda: values["enable-agenda"],
    ...(devices ? { devices } : {}),
    ...(appClients ? { appClients } : {}),
    ...(values["owner-control-socket"] !== undefined ? { ownerControl: { socketPath: values["owner-control-socket"] } } : {}),
    ...(memoryOrigin ? { context: { ownerExclusiveDeployment: values["ai-memory-owner-exclusive"], memory: {
      origin: memoryOrigin,
      ...(values["ai-memory-lab"] ? { labLoopbackWithoutAuth: true } : { credential: () => memoryUserKey ?? "" }),
    } } } : {}),
  };
  if (sealedMode && values["enable-device-tools"] && (!values["enable-mcp"] || !values["enable-engines"]))
    throw new HostError("invalid_input", "Device tools require explicit MCP and engines.");
  // Pure preflight of all other configuration before any canonical directory, custody or password read.
  let plan = planHostStartup({ route: "production", options: sealedMode ? { ...startupOptions, enableDeviceTools: false } : startupOptions, ...(startupProviders ? { providers: startupProviders } : {}) });
  let custody: OperatorSealedCustody | undefined;
  let appCustody: OperatorSealedCustody | undefined;
  let bootstrapStore: HostStore | undefined;
  let lifetime: ReturnType<typeof setInterval> | undefined;
  let signalStop: (() => void) | undefined;
  let stopRequested = false;
  const heldSignal = (): void => { stopRequested = true; signalStop?.(); };
  const releaseLifetime = (): void => {
    if (lifetime) clearInterval(lifetime);
    lifetime = undefined;
    if (sealedMode) { process.off("SIGINT", heldSignal); process.off("SIGTERM", heldSignal); }
  };
  const retain = async (): Promise<never> => {
    process.stderr.write("Host cleanup is not confirmed; canonical writer and encrypted custody retained.\n");
    process.exitCode = 1;
    return await new Promise<never>(() => {});
  };
  if (sealedMode) {
    // Keep references and repeated-signal handlers until confirmed drain, including startup uncertainty.
    lifetime = setInterval(() => { void custody; void appCustody; void bootstrapStore; }, 2 ** 30);
    process.on("SIGINT", heldSignal); process.on("SIGTERM", heldSignal);
    try {
      let existingInstallation;
      if (custodyAction === "unlock" || appSealedMode) {
        const existing = readHubIdentity(dataDir);
        if (appSealedMode && (existing.installationId !== appExpectedHost || existing.ownerId !== appExpectedOwner))
          throw new HostError("conflict", "Desktop app client installation changed before preparation.");
        existingInstallation = { installationId: existing.installationId, ownerId: existing.ownerId };
        if (readSourceAuthority(dataDir).state !== "active") throw new HostError("conflict", "Canonical host authority is not active.");
      }
      try { bootstrapStore = new HostStore({ dataDir, ...(existingInstallation ? { existingInstallation } : {}) }); }
      catch (error) { if (!(error instanceof HostError)) return await retain(); throw error; }
      if (deviceSealedMode) {
        const prepared = await openLocalDeviceCustody(bootstrapStore, custodyFile!, custodyAction as "create" | "unlock",
          () => browserUsePrivateInput ? readBrowserUseUnlockFrame() : readLocalDevicePasswordFd(Number(passwordFd)), devicePort);
        custody = prepared.custody; devices = prepared.devices;
      }
      if (appSealedMode) {
        const prepared = await openDesktopAppClientCustody(bootstrapStore,appCustodyFile!,appCustodyAction as "create"|"unlock",
          {installationId:appExpectedHost!,ownerId:appExpectedOwner!},() => readBrowserUseUnlockFrame(),values["app-client-listen"]!,appPort);
        appCustody=prepared.custody;appClients=prepared.appClients;
      }
      existingInstallation = { installationId: bootstrapStore.hostId, ownerId: bootstrapStore.ownerId };
      bootstrapStore.close(); bootstrapStore = undefined;
      plan = planHostStartup({ route: "production", options: { ...startupOptions, devices, appClients, existingInstallation }, ...(startupProviders ? { providers: startupProviders } : {}) });
    } catch (error) {
      try { bootstrapStore?.close(); bootstrapStore = undefined; await appCustody?.close(); await custody?.close(); }
      catch { return await retain(); }
      releaseLifetime(); throw error;
    }
  }
  let services;
  try { services = plan.open(); }
  catch (error) {
    // Constructor uncertainty may have retained an inaccessible writer/runtime. Do not release custody.
    if (sealedMode) return await retain();
    throw error;
  }
  const { store, runtime } = services;
  custodyServices = services;
  const connectionsComposition = (): ConnectionsComposition => {
    const origin = services.connectionsServiceOrigin, owned = connectionsStartup.composition;
    if (origin === null) return null;
    return owned && owned.source === "owner_private" && owned.origin === origin ? owned : { source: "external", origin };
  };
  let browserUseInput: ReturnType<typeof bindBrowserUsePrivateInput> | undefined;
  try {
    const deviceUrl = devices ? await services.startDevices() : null;
    const appClientUrl = appClients ? await services.startAppClients() : null;
    const ownerControlPath = values["owner-control-socket"] !== undefined ? await services.startOwnerControl() : null;
    const app = createHostApp(store, { ...(services.nativeVoice?{nativeVoice:services.nativeVoice}:{}), ...(runtime ? { runtime } : {}), ...(services.peersHttp ? { devices: services.peersHttp } : {}),
      engineCatalog:services.engineCatalog,
      skills:services.skillsHttp,
      botDocuments:services.botDocumentsHttp,
      ownerConfiguration:services.ownerConfigurationHttp,
      teams:services.teamsHttp,
      ...(services.groups ? {groups:services.groups}:{}),
      browserUse:services.browserUseHttp,
      memoryBackend:services.memoryBackendHttp,
      ...(services.automationsHttp?{automations:services.automationsHttp}:{}),
      ...(services.botDelegation ? { botDelegation: services.botDelegation } : {}),
      ...(services.localDeviceSetupHttp ? { localDeviceSetup: services.localDeviceSetupHttp } : {}),
      ...(services.deviceRoutesHttp ? { deviceRoutes: services.deviceRoutesHttp } : {}),
      ...(services.deviceGrantsHttp ? { deviceGrants: services.deviceGrantsHttp } : {}),
      ...(services.nativeMcpHttp ? { mcp: services.nativeMcpHttp } : {}),
      // Owner-loopback connections: honest `unconfigured` managed route unless a trusted embedding injects the service.
      // Owner-loopback connections; a service composed from the owner-private configuration is never `available` without
      // its private capability. Configuration: metadata over loopback; the capability only over the private pipe below.
      connections: withPrivateCustodyStatus(services.connectionsHttp, { composition: connectionsComposition, custody: connectionsStartup.vault ?? null }),
      connectionWorkflows:services.connectionWorkflows,
      outputFiles: services.outputFilesHttp,
      connectionsConfiguration: connectionsConfigurationHttpPort({ ledger: () => services.connectionsConfigurationLedger,
        identity: () => ({ hostId: store.hostId, ownerId: store.ownerId }), environment: connectionsStartup.environment,
        composition: connectionsComposition, custody: connectionsStartup.vault ?? null }),
      // Owner pairing offers of this host's app-client channel; `unconfigured` without --app-client-identity-dir.
      ownerPairingOffers: services.ownerPairingOffersHttp });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (address) => {
      connectionsStartup.vault?.arm(store.hostId);
      if (browserUsePrivateInput) browserUseInput = bindBrowserUsePrivateInput(process.stdin, store.hostId, services.browserUseKeyVault, outputLine => process.stdout.write(`${outputLine}\n`), services.memoryBackendPrivateInput, oauthChannel, connectionsStartup.vault);
      services.startAgenda();
      services.startMemoryLearning();
      output({ status: "ready", mode: "local-development", url: `http://127.0.0.1:${address.port}`, hostId:store.hostId, ownerId:store.ownerId, databasePath: store.databasePath,
        engineExecution: runtime ? "enabled" : "disabled", mcpGateway: services.gateway ? "enabled" : "disabled",
        deviceTurnTools: values["enable-device-tools"] ? "enabled" : "disabled",
        botDelegation: services.botDelegation ? "enabled" : "disabled",
        agenda: plan.description.agenda ? "enabled" : "disabled",
        upstreamApps: services.upstreamConfigured ? "configured" : "unconfigured",
        nativeMcp: plan.description.nativeMcp === "unconfigured" ? "disabled" : "enabled",
        deviceChannel: deviceUrl ? { status: "listening", url: deviceUrl } : { status: "unconfigured" },
        appClientChannel: appClientUrl ? { status: "listening", url: appClientUrl } : { status: "unconfigured" },
        ownerControl: ownerControlPath ? { status: "listening", socket: ownerControlPath } : { status: "unconfigured" },
        context: services.context ? "enabled" : "disabled", memoryIndex: services.memorySync ? "unverified" : "unconfigured",
        trustedProviders: { relay: plan.description.relay, relayRecovery: plan.description.relayRecovery, managedApps: plan.description.managedApps } });
      // After ready: armed, but silent until the app's open frame (sent once it parsed ready). Durability is claimed only
      // if the app confirms custody; then OAuth instances are restored once (no retry loop) and in-memory authorizations
      // refused earlier are persisted. Failures stay per instance and visible as "Precisa reconectar".
      if (oauthChannel && oauthCustody) {
        oauthChannel.arm({ hostID: store.hostId, write: line => process.stdout.write(`${line}\n`),
          onOpen: () => { void oauthCustody.verify().then(state => state === "durable" ? services.restoreNativeMcpOAuth() : undefined).catch(() => undefined); } });
      }
    });
    const closeState = async (): Promise<void> => {
      await browserUseInput?.close();
      oauthChannel?.close();
      connectionsStartup.vault?.close();
      await shutdownRuntime(services);
      await appCustody?.close();
      await custody?.close();
      releaseLifetime();
    };
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      // Stop accepting new turns before releasing the canonical writer lease.
      void closeState().catch(async () => { process.exitCode = 1; if (sealedMode) await retain(); });
      server.close();
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      setTimeout(() => { if ("closeAllConnections" in server) server.closeAllConnections(); }, 1_000).unref();
    };
    server.on("error", () => { process.stderr.write("Host listener failed.\n"); process.exitCode = 1; stop(); });
    if (sealedMode) { signalStop = stop; if (stopRequested) stop(); }
    else { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  } catch (error) {
    await browserUseInput?.close();
    oauthChannel?.close();
    try { await shutdownRuntime(services); await appCustody?.close(); await custody?.close(); releaseLifetime(); }
    catch { if (sealedMode) return await retain(); throw new HostError("conflict", "Host cleanup was not confirmed."); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try { await main(); } catch (error) {
    const message = error instanceof HostError ? `${error.code}: ${error.message}` : "Command failed. Check arguments and host state.";
    process.stderr.write(message + "\n");
    process.exitCode = 1;
  }
}
