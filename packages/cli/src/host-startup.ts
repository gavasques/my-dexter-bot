import { resolve } from "node:path";
import { types } from "node:util";
import { HostError, SCHEMA_VERSION, type HostStore } from "@dexter/hub";
import { ConnectionsRuntime, ManagedAppsRuntime, checkMcpEgressPolicy, type McpOAuthTokenStore } from "@dexter/connectors";
import { AiMemoryHttpClient, AiMemorySync } from "@dexter/context";
import { TlsIdentity } from "@dexter/devices";
import { readHubIdentity, readSourceAuthority } from "@dexter/operations";
import { custodySnapshot, validateRelayHostOptions, type CustodyMode, type RelayCustodyProvider, type RelayHostOptions } from "@dexter/relay-host";
import { HostServices, type HostRelayRecoveryOptions, type HostServicesOptions } from "./host-services.js";
import { validateDeviceServicesOptions } from "./device-services.js";
import { validateAppClientServicesOptions } from "./app-client-services.js";
import { validateOwnerControlOptions } from "./owner-control.js";
import { snapshotEngineCommands, type EngineCommands } from "./engine-command-config.js";
import { nativeMcpOnePassword, type NativeMcpOnePasswordConfig } from "./native-mcp-config.js";

/**
 * Normal trusted startup: ONE validated composition route shared by `dexter serve` and an operator-owned embedding.
 *
 * - Public options carry every enable flag. Providers can never turn a feature on: each provider requires its explicit
 *   public intent flag, and each intent flag requires its provider (`enableRelay` ⇔ `providers.relay`, ...).
 * - Providers are statically injected trusted objects (no HTTP, engine, env, JSON or module path). No default, memory,
 *   generated or environment provider exists here, and the plain executable never supplies one.
 * - Every nested input is first copied as whitelisted DATA: proxies, accessors, symbols and unknown keys (including
 *   `toJSON`) are refused without running any trap, getter, hook or provider method. Opaque provider methods are
 *   captured from data descriptors and called later with their original receiver; nothing is invoked here.
 * - Everything is validated at plan time, before any data directory, store, writer, socket or provider call exists.
 *   Relay/recovery additionally require an already-initialized canonical installation, read without writing; the
 *   captured identity then makes the actual writer open existing-only (no CREATE) and re-admitted on that same handle.
 * - `production` route refuses laboratory custody. A `persistent` label is the operator's selection only: this module
 *   does not prove physical custody (`persistentCustodyVerified: false`).
 */
export type HostStartupRoute = "production" | "laboratory";

export interface HostStartupPublicOptions {
  dataDir: string;
  /** Exact public identity of a pre-existing host; actual writer open is existing-only. */
  existingInstallation?: HostServicesOptions["existingInstallation"];
  enableEngines?: boolean;
  /** Absolute native executables selecting EXACTLY these engines. Requires `enableEngines`; paths never enable it. */
  engineCommands?: EngineCommands;
  enableMcp?: boolean;
  enableBotDelegation?: boolean;
  /**
   * Owner-local native MCP connections (empty until the owner adds one). Requires `enableMcp`. `oauthCustody`
   * "app_private_channel" is the public intent for durable OAuth custody by the owning app (UX-P1-10); it requires the
   * trusted `providers.nativeMcpOAuth` store and is never inferred from a provider.
   */
  nativeMcp?: { runsOn: "owner_mac" | "cloud"; onePassword?: NativeMcpOnePasswordConfig; oauthCustody?: "app_private_channel"; privateOrigins?:readonly string[] };
  enableDeviceTools?: boolean;
  /** Existing trusted manual Agenda (no timer, no HTTP tick). Requires engines. */
  enableAgenda?: boolean;
  /** Public intent: the trusted embedding MUST inject `providers.relay`. */
  enableRelay?: boolean;
  /** Public intent: the trusted embedding MUST inject `providers.relayRecovery`. */
  enableRelayRecovery?: boolean;
  /** Public intent: the trusted embedding MUST inject `providers.managedApps`. */
  enableManagedApps?: boolean;
  /** Public intent: the trusted embedding MUST inject `providers.connections` (trusted connections service + capability). */
  enableConnections?: boolean;
  devices?: HostServicesOptions["devices"];
  appClients?: HostServicesOptions["appClients"];
  ownerControl?: HostServicesOptions["ownerControl"];
  context?: HostServicesOptions["context"];
}

/** Operator-owned, statically injected trusted provider dependencies. Ownership stays with the caller until `open()` succeeds. */
export interface HostStartupProviders {
  relay?: RelayHostOptions;
  relayRecovery?: HostRelayRecoveryOptions;
  managedApps?: NonNullable<HostServicesOptions["managedApps"]>;
  connections?: NonNullable<HostServicesOptions["connections"]>;
  /** Durable native MCP OAuth token store over the app-owned private channel (load/save/remove/durability). */
  nativeMcpOAuth?: { store: McpOAuthTokenStore };
}

export interface HostStartupInput {
  route: HostStartupRoute;
  options: HostStartupPublicOptions;
  providers?: HostStartupProviders;
  /** Laboratory route only (synthetic engines). */
  makeDriver?: HostServicesOptions["makeDriver"];
}

type ProviderState = "unconfigured" | "configured";
export interface HostStartupDescription {
  route: HostStartupRoute;
  dataDir: string;
  engines: boolean; mcp: boolean; deviceTools: boolean; agenda: boolean;
  nativeMcp: "unconfigured" | "owner_mac" | "cloud";
  /** Configured custody path only; durability is confirmed later by the custodian itself (never claimed here). */
  nativeMcpOAuthCustody: "memory" | "app_private_channel_unverified" | "unconfigured";
  relay: ProviderState | { status: "configured"; custodyMode: CustodyMode; transportOwnership: "borrowed" | "owned"; persistentCustodyVerified: false };
  relayRecovery: ProviderState | { status: "configured"; nextRecipient: CustodyMode | null; persistentCustodyVerified: false };
  managedApps: ProviderState;
  connections: ProviderState;
}

export interface HostStartupPlan {
  readonly description: Readonly<HostStartupDescription>;
  /** Single use. Constructs the existing HostServices (which revalidates and owns lifecycle). Constructor failure leaves
   *  provider/transport ownership with the caller; no provider method is called by the plan. */
  open(): HostServices;
}

const PUBLIC_KEYS = ["dataDir", "enableEngines", "engineCommands", "enableMcp", "enableBotDelegation", "enableDeviceTools", "enableAgenda", "enableRelay", "enableRelayRecovery",
  "enableManagedApps", "enableConnections", "devices", "appClients", "ownerControl", "context", "nativeMcp", "existingInstallation"] as const;
const FLAGS = ["enableEngines", "enableMcp", "enableBotDelegation", "enableDeviceTools", "enableAgenda", "enableRelay", "enableRelayRecovery", "enableManagedApps", "enableConnections"] as const;
const PROVIDER_KEYS = ["relay", "relayRecovery", "managedApps", "connections", "nativeMcpOAuth"] as const;
const MANAGED_KEYS = ["provider", "broker", "credentialRef", "fetch", "origin", "authHeaders", "limits", "secretValues", "disposeOwnedBroker"];
const RELAY_KEYS = ["recipient", "custody", "custodyMode", "transport", "transportOwnership", "deployment", "maximumAssociations", "maximumOperations", "dispatchMs"];
const PIN_KEYS = ["ownerId", "installationId", "deviceId", "generation", "keyId", "signingPublicKey", "encryptionPublicKey"];
const DEVICE_KEYS = ["identity", "listenHost", "port", "pollWaitMs", "receiptTimeoutMs", "maxConnections", "maxDispatches"];
const APP_CLIENT_KEYS = ["identity", "listenHost", "port", "advertisedOrigin", "offerTtlMs", "maxConnections", "maxInFlight", "headersTimeoutMs", "requestTimeoutMs"];
const MEMORY_KEYS = ["origin", "credential", "labLoopbackWithoutAuth", "timeoutMs", "maxResponseBytes", "fetch"];
/** Same bound as HostServices `recoveryConfig` and RelayAssociations; a parity test pins it to HostServices. */
const MAX_RECOVERY_ASSOCIATIONS = 100_000;
/** Captured at load: the only accessor ever run here is this trusted dependency's own private-key getter. */
const TLS_KEY_GETTER = Object.getOwnPropertyDescriptor(TlsIdentity.prototype, "keyPem")?.get;

const refuse = (message: string): never => { throw new HostError("invalid_input", message); };
type Fn = (...args: unknown[]) => unknown;

/** Own enumerable string-keyed DATA properties of a plain, non-proxy object, whitelisted. Runs no trap, getter or hook. */
function record(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return refuse(`Invalid ${what}.`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) refuse(`Invalid ${what}.`);
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !allowed.includes(key) || !("value" in descriptor) || !descriptor.enumerable) return refuse(`Invalid ${what}.`);
    if (descriptor.value !== undefined) out[key] = descriptor.value;
  }
  return out;
}
/** Primitive scalars only; range/shape stay with the existing validators. */
function scalars(raw: Record<string, unknown>, keys: readonly string[], what: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") refuse(`Invalid ${what}.`);
    out[key] = v;
  }
  return out;
}
/** Non-proxy function, deferred with its original receiver. Not invoked, and `bind` (which reads name/length) is not used. */
function deferred(value: unknown, self: unknown, what: string): Fn {
  if (typeof value !== "function" || types.isProxy(value)) return refuse(`Invalid ${what}.`);
  const fn = value as Fn;
  return (...args: unknown[]) => Reflect.apply(fn, self, args);
}
const optionalDeferred = (value: unknown, self: unknown, what: string): Fn | undefined => value === undefined ? undefined : deferred(value, self, what);
/** Method of an opaque trusted object (plain or class instance): data descriptor on the object or its prototype chain. */
function method(target: unknown, name: string, what: string): Fn {
  if (target === null || typeof target !== "object" || types.isProxy(target)) return refuse(`Invalid ${what}.`);
  for (let o: object | null = target, depth = 0; o !== null && depth < 32; o = Object.getPrototypeOf(o) as object | null, depth++) {
    if (types.isProxy(o)) return refuse(`Invalid ${what}.`);
    const descriptor = Object.getOwnPropertyDescriptor(o, name);
    if (descriptor) return "value" in descriptor ? deferred(descriptor.value, target, what) : refuse(`Invalid ${what}.`);
  }
  return refuse(`Invalid ${what}.`);
}
/** Array of strings as data: no proxy, accessor, extra key, hole or custom prototype. */
function strings(value: unknown, max: number, what: string): readonly string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return refuse(`Invalid ${what}.`);
  const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
  if (length > max || Reflect.ownKeys(value).length !== length + 1) refuse(`Invalid ${what}.`);
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") refuse(`Invalid ${what}.`);
    out.push(descriptor!.value as string);
  }
  return Object.freeze(out);
}
const pinData = (value: unknown, what: string) => Object.freeze(scalars(record(value, PIN_KEYS, what), PIN_KEYS, what));

/** Genuine frozen TlsIdentity (own data cert/fingerprint, original key getter) or plain data; always re-created. */
function tlsIdentity(value: unknown, what: string): TlsIdentity {
  if (value !== null && typeof value === "object" && !types.isProxy(value) && Object.getPrototypeOf(value) === TlsIdentity.prototype) {
    const own = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(own);
    const current = Object.getOwnPropertyDescriptor(TlsIdentity.prototype, "keyPem")?.get;
    if (keys.length !== 2 || !keys.includes("certPem") || !keys.includes("fingerprint") || !("value" in own["certPem"]!) || !("value" in own["fingerprint"]!)
      || !TLS_KEY_GETTER || current !== TLS_KEY_GETTER) return refuse(`Invalid ${what}.`);
    const certPem = own["certPem"]!.value as unknown, fingerprint = own["fingerprint"]!.value as unknown;
    let keyPem: unknown;
    try { keyPem = TLS_KEY_GETTER.call(value); } catch { return refuse(`Invalid ${what}.`); }
    if (typeof certPem !== "string" || typeof keyPem !== "string" || typeof fingerprint !== "string") return refuse(`Invalid ${what}.`);
    return new TlsIdentity(certPem, keyPem, fingerprint);
  }
  const x = record(value, ["certPem", "keyPem", "fingerprint"], what);
  if (typeof x["certPem"] !== "string" || typeof x["keyPem"] !== "string" || typeof x["fingerprint"] !== "string") return refuse(`Invalid ${what}.`);
  return new TlsIdentity(x["certPem"], x["keyPem"], x["fingerprint"]);
}

/** Plain opaque custody with exactly the relay contract keys; methods deferred on the original provider. */
function custodyData(value: unknown, what: string): RelayCustodyProvider {
  const x = record(value, ["kind", "publicPin", "current", "sign", "decrypt", "close"], what);
  if (typeof x["kind"] !== "string") refuse(`Invalid ${what}.`);
  return Object.freeze({ kind: x["kind"], publicPin: pinData(x["publicPin"], what),
    current: deferred(x["current"], value, what), sign: deferred(x["sign"], value, what),
    decrypt: deferred(x["decrypt"], value, what), close: deferred(x["close"], value, what) }) as unknown as RelayCustodyProvider;
}

function relayData(value: unknown): RelayHostOptions {
  const what = "relay provider", x = record(value, RELAY_KEYS, what);
  const t = record(x["transport"], ["poll", "ack", "close"], what);
  return Object.freeze({
    ...scalars(x, ["custodyMode", "transportOwnership", "maximumAssociations", "maximumOperations", "dispatchMs"], what),
    recipient: pinData(x["recipient"], what), custody: custodyData(x["custody"], what),
    transport: Object.freeze({ poll: deferred(t["poll"], x["transport"], what), ack: deferred(t["ack"], x["transport"], what), close: deferred(t["close"], x["transport"], what) }),
    deployment: Object.freeze(scalars(record(x["deployment"], ["maximumPendingPerRecipient"], what), ["maximumPendingPerRecipient"], what)),
  }) as unknown as RelayHostOptions;
}

/** Same pure snapshot contract as HostServices: deferred methods, no provider/broker call, no I/O. */
function managedSnapshot(raw: unknown): NonNullable<HostServicesOptions["managedApps"]> {
  const what = "managed apps provider", x = record(raw, MANAGED_KEYS, what);
  const provider = x["provider"], broker = x["broker"];
  const snapshot = Object.freeze({
    ...scalars(x, ["credentialRef", "origin"], what),
    provider: Object.freeze({ catalog: method(provider, "catalog", what), provision: method(provider, "provision", what),
      lookup: method(provider, "lookup", what), account: method(provider, "account", what) }),
    broker: Object.freeze({ acquire: method(broker, "acquire", what), secretValues: method(broker, "secretValues", what) }),
    fetch: deferred(x["fetch"], raw, what),
    ...(x["authHeaders"] !== undefined ? { authHeaders: strings(x["authHeaders"], 8, what) } : {}),
    ...(x["limits"] !== undefined ? { limits: Object.freeze(scalars(record(x["limits"], ["timeoutMs", "maxRequestBytes", "maxResponseBytes"], what),
      ["timeoutMs", "maxRequestBytes", "maxResponseBytes"], what)) } : {}),
    ...(x["secretValues"] !== undefined ? { secretValues: deferred(x["secretValues"], raw, what) } : {}),
    ...(x["disposeOwnedBroker"] !== undefined ? { disposeOwnedBroker: deferred(x["disposeOwnedBroker"], raw, what) } : {}),
  }) as unknown as NonNullable<HostServicesOptions["managedApps"]>;
  // Pure validation instance of the actual runtime: no database, timer, credential read or disposal.
  try { new ManagedAppsRuntime({ ...snapshot, identity: { installationId: "validation", ownerId: "validation" } }); }
  catch { return refuse("Invalid managed apps provider."); }
  return snapshot;
}

/** Data-only snapshot of the trusted connections provider: deferred capability/fetch, no call, no I/O. */
function connectionsSnapshot(raw: unknown): NonNullable<HostServicesOptions["connections"]> {
  const what = "connections provider", x = record(raw, ["platform", "credentialRef"], what);
  const p = record(x["platform"], ["origin", "capability", "fetch", "limits"], what);
  const snapshot = Object.freeze({
    ...scalars(x, ["credentialRef"], what),
    platform: Object.freeze({ ...scalars(p, ["origin"], what), capability: deferred(p["capability"], x["platform"], what), fetch: deferred(p["fetch"], x["platform"], what),
      ...(p["limits"] !== undefined ? { limits: Object.freeze(scalars(record(p["limits"], ["timeoutMs", "maxRequestBytes", "maxResponseBytes"], what),
        ["timeoutMs", "maxRequestBytes", "maxResponseBytes"], what)) } : {}) }),
  }) as unknown as NonNullable<HostServicesOptions["connections"]>;
  try { new ConnectionsRuntime({ ...snapshot, identity: { installationId: "validation", ownerId: "validation" } }); }
  catch { return refuse("Invalid connections provider."); }
  return snapshot;
}

/** Data-only snapshot of the trusted OAuth token store: deferred methods, no call, no token read. */
function oauthStoreSnapshot(raw: unknown): McpOAuthTokenStore {
  const what = "native MCP OAuth custody", x = record(raw, ["store"], what), store = x["store"];
  return Object.freeze({ load: method(store, "load", what) as McpOAuthTokenStore["load"], save: method(store, "save", what) as McpOAuthTokenStore["save"],
    remove: method(store, "remove", what) as McpOAuthTokenStore["remove"], durability: method(store, "durability", what) as NonNullable<McpOAuthTokenStore["durability"]> });
}

class SyncBoundsAccepted extends Error {}
/** Validation-only stand-in: AiMemorySync checks its bounds first; its first store use (the writer lease) stops it here. */
const SYNC_BOUNDS_PROBE = Object.freeze({ hostId: "validation", ownerId: "validation", databasePath: "/validation/dexter.sqlite",
  withWriterLease: () => { throw new SyncBoundsAccepted(); } }) as unknown as HostStore;

function contextSnapshot(raw: unknown): NonNullable<HostServicesOptions["context"]> {
  const what = "context configuration", x = record(raw, ["memory", "ownerExclusiveDeployment", "sync"], what);
  if (x["ownerExclusiveDeployment"] !== true) refuse("Context requires MCP and an owner-exclusive ai-memory deployment.");
  const m = record(x["memory"], MEMORY_KEYS, what);
  const memory = Object.freeze({ ...scalars(m, ["origin", "labLoopbackWithoutAuth", "timeoutMs", "maxResponseBytes"], what),
    ...(m["credential"] !== undefined ? { credential: optionalDeferred(m["credential"], x["memory"], what) } : {}),
    ...(m["fetch"] !== undefined ? { fetch: optionalDeferred(m["fetch"], x["memory"], what) } : {}) }) as unknown as NonNullable<HostServicesOptions["context"]>["memory"];
  const sync = x["sync"] === undefined ? undefined
    : Object.freeze(scalars(record(x["sync"], ["maxJobsPerFlush", "maxDiscoveredPerFlush"], what), ["maxJobsPerFlush", "maxDiscoveredPerFlush"], what));
  // The actual constructors' rules: origin/auth mode (HttpClient, no request) and both flush bounds (AiMemorySync).
  let client: AiMemoryHttpClient;
  try { client = new AiMemoryHttpClient(memory); } catch { return refuse("Invalid ai-memory origin or authentication mode."); }
  let accepted = false;
  try { new AiMemorySync(SYNC_BOUNDS_PROBE, { activeMemoryPagesForSync: () => [] } as never, client, sync ?? {}); }
  catch (error) { accepted = error instanceof SyncBoundsAccepted; }
  finally { void client.close(); }
  if (!accepted) refuse("Invalid ai-memory sync configuration.");
  return Object.freeze({ memory, ownerExclusiveDeployment: true, ...(sync ? { sync } : {}) });
}

function custodyAllowed(route: HostStartupRoute, mode: unknown): void {
  if (route === "production" && mode !== "persistent" && mode !== "operator-sealed-exportable") refuse("Production startup refuses laboratory relay custody.");
  if (route === "laboratory" && mode !== "laboratory-memory") refuse("Laboratory startup accepts only laboratory-labelled relay custody.");
}

function recoverySnapshot(route: HostStartupRoute, raw: unknown): { options: HostRelayRecoveryOptions; next: CustodyMode | null; pin: Readonly<Record<string, unknown>> | null } {
  const what = "relay recovery provider", x = record(raw, ["nextRecipient", "maximumAssociations"], what);
  const maximum = x["maximumAssociations"];
  if (maximum !== undefined && (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_RECOVERY_ASSOCIATIONS))
    refuse("Invalid relay recovery configuration.");
  if (x["nextRecipient"] === undefined) return { options: Object.freeze(maximum !== undefined ? { maximumAssociations: maximum as number } : {}), next: null, pin: null };
  const n = record(x["nextRecipient"], ["custody", "custodyMode"], what);
  custodyAllowed(route, n["custodyMode"]);
  const data = custodyData(n["custody"], what), mode = n["custodyMode"] as CustodyMode;
  let custody: Readonly<RelayCustodyProvider>;
  try { custody = custodySnapshot(data, mode, data.publicPin); } catch { return refuse("Invalid relay recovery provider."); }
  return { options: Object.freeze({ nextRecipient: Object.freeze({ custody, custodyMode: mode }), ...(maximum !== undefined ? { maximumAssociations: maximum as number } : {}) }),
    next: mode, pin: data.publicPin as unknown as Record<string, unknown> };
}

/**
 * Public installation/owner of an EXISTING canonical store, read without writing (immutable when closed, read-only
 * beside a live writer's WAL pair; nothing created). Empty, corrupt, legacy/unsupported, non-active or missing-identity
 * databases refuse. Reuses the operations package's read-only readers; never a HostStore, writer or lease.
 */
function initializedIdentity(dataDir: string): { installationId: string; ownerId: string } {
  try {
    const hub = readHubIdentity(dataDir), authority = readSourceAuthority(dataDir);
    if (hub.schemaVersion !== SCHEMA_VERSION || authority.schemaVersion !== SCHEMA_VERSION || authority.state !== "active"
      || authority.installationId !== hub.installationId || authority.ownerId !== hub.ownerId) throw new Error();
    return { installationId: hub.installationId, ownerId: hub.ownerId };
  } catch { return refuse("Relay startup requires an initialized canonical store; identity is never generated for a provider."); }
}

/**
 * Pure preflight. Never creates the data directory, opens the store/writer, binds a socket or calls a provider method.
 * Throws `invalid_input` on any refused combination.
 */
export function planHostStartup(input: HostStartupInput): HostStartupPlan {
  const top = record(input, ["route", "options", "providers", "makeDriver"], "startup input");
  const route = top["route"];
  if (route !== "production" && route !== "laboratory") return refuse("Invalid startup route.");
  if (top["makeDriver"] !== undefined && (route !== "laboratory" || typeof top["makeDriver"] !== "function" || types.isProxy(top["makeDriver"])))
    refuse("Synthetic drivers are laboratory-only.");
  const pub = record(top["options"], PUBLIC_KEYS, "startup options");
  const providers = top["providers"] === undefined ? {} : record(top["providers"], PROVIDER_KEYS, "startup providers");
  for (const flag of FLAGS) if (pub[flag] !== undefined && typeof pub[flag] !== "boolean") refuse("Invalid host feature configuration.");
  const on = (flag: (typeof FLAGS)[number]) => pub[flag] === true;
  if (typeof pub["dataDir"] !== "string" || pub["dataDir"].length === 0) refuse("A data directory is required.");
  const dataDir = resolve(pub["dataDir"] as string);

  // Intent ⇔ provider. A provider can never enable a feature behind the operator, and intent never falls back.
  if (on("enableRelay") && on("enableRelayRecovery")) refuse("Relay and relay recovery are mutually exclusive.");
  for (const [flag, key] of [["enableRelay", "relay"], ["enableRelayRecovery", "relayRecovery"], ["enableManagedApps", "managedApps"], ["enableConnections", "connections"]] as const) {
    if (on(flag) && providers[key] === undefined) refuse(`Startup requires an operator-injected ${key} provider; none is configured.`);
    if (!on(flag) && providers[key] !== undefined) refuse(`A ${key} provider requires its explicit enable flag.`);
  }
  // Same refusals (and messages) as HostServices, raised here before any nested snapshot.
  if (on("enableDeviceTools") && (pub["devices"] === undefined || !on("enableMcp") || !on("enableEngines")))
    refuse("Device tools require paired-device configuration and MCP engines.");
  if (on("enableBotDelegation") && (!on("enableEngines") || !on("enableMcp"))) refuse("Bot delegation requires explicit engines and MCP.");
  if (on("enableAgenda") && !on("enableEngines")) refuse("Agenda requires enabled engines.");
  if (pub["engineCommands"] !== undefined && !on("enableEngines")) refuse("Engine commands require enabled engines.");
  if (on("enableManagedApps") && (!on("enableMcp") || !on("enableEngines"))) refuse("Managed apps require MCP engines and exclusive upstream configuration.");
  if (on("enableConnections") && (!on("enableMcp") || !on("enableEngines") || on("enableManagedApps"))) refuse("Connections require MCP engines and exclusive upstream configuration.");
  if (on("enableRelay") && (!on("enableEngines") || pub["appClients"] === undefined)) refuse("Relay requires enabled engines and canonical app clients.");
  if (on("enableRelayRecovery") && pub["appClients"] === undefined) refuse("Relay recovery requires canonical app clients.");
  if (on("enableMcp") && !on("enableEngines")) refuse("MCP requires enabled engines.");
  if (pub["ownerControl"] !== undefined && pub["appClients"] === undefined) refuse("Owner control requires the app client channel.");
  if (pub["context"] !== undefined && !on("enableMcp")) refuse("Context requires MCP and an owner-exclusive ai-memory deployment.");
  let nativeMcp: HostServicesOptions["nativeMcp"];
  if (pub["nativeMcp"] !== undefined) {
    const native = record(pub["nativeMcp"], ["runsOn", "onePassword", "oauthCustody", "privateOrigins"], "native MCP configuration");
    const runsOn = native["runsOn"];
    if (runsOn !== "owner_mac" && runsOn !== "cloud") refuse("Invalid native MCP configuration.");
    if (!on("enableMcp")) refuse("Native MCP requires MCP engines.");
    let onePassword: NativeMcpOnePasswordConfig | undefined;
    if (native["onePassword"] !== undefined) {
      const op = record(native["onePassword"], ["command", "vault", "account"], "native MCP 1Password configuration");
      if (typeof op["command"] !== "string" || typeof op["vault"] !== "string"
        || (op["account"] !== undefined && typeof op["account"] !== "string")) refuse("Invalid native MCP 1Password configuration.");
      onePassword = Object.freeze({ command: op["command"] as string, vault: op["vault"] as string,
        ...(op["account"] === undefined ? {} : { account: op["account"] as string }) });
      nativeMcpOnePassword(onePassword); // pure preflight, no read or process
    }
    const custodyIntent = native["oauthCustody"];
    if (custodyIntent !== undefined && (custodyIntent !== "app_private_channel" || runsOn !== "owner_mac")) refuse("Invalid native MCP OAuth custody.");
    if ((custodyIntent !== undefined) !== (providers["nativeMcpOAuth"] !== undefined)) refuse("Native MCP OAuth custody requires both its explicit intent and the trusted store.");
    const oauthStore = providers["nativeMcpOAuth"] !== undefined ? oauthStoreSnapshot(providers["nativeMcpOAuth"]) : undefined;
    let egress;try{egress=checkMcpEgressPolicy({placement:runsOn,...(native["privateOrigins"]!==undefined?{privateOrigins:native["privateOrigins"]}:{})});}catch{return refuse("Invalid private MCP origins.");}
    nativeMcp = Object.freeze({ runsOn: runsOn as "owner_mac" | "cloud", ...(native["privateOrigins"]!==undefined?{privateOrigins:egress.privateOrigins!}:{}), ...(onePassword ? { onePassword } : {}), ...(oauthStore ? { oauth: Object.freeze({ store: oauthStore }) } : {}) });
  } else if (providers["nativeMcpOAuth"] !== undefined) refuse("Native MCP OAuth custody requires both its explicit intent and the trusted store.");

  // 1. Data-only snapshots of every nested object (no trap/getter/hook/provider call), then the existing pure validators.
  let devices: HostServicesOptions["devices"];
  if (pub["devices"] !== undefined) {
    const x = record(pub["devices"], DEVICE_KEYS, "device channel configuration");
    devices = validateDeviceServicesOptions({ ...scalars(x, DEVICE_KEYS.slice(1), "device channel configuration"),
      identity: tlsIdentity(x["identity"], "device channel configuration") } as NonNullable<HostServicesOptions["devices"]>);
  }
  let appClients: HostServicesOptions["appClients"];
  if (pub["appClients"] !== undefined) {
    const x = record(pub["appClients"], APP_CLIENT_KEYS, "app client configuration");
    appClients = validateAppClientServicesOptions({ ...scalars(x, APP_CLIENT_KEYS.slice(1), "app client configuration"),
      identity: tlsIdentity(x["identity"], "app client configuration") } as NonNullable<HostServicesOptions["appClients"]>);
  }
  const ownerControl = pub["ownerControl"] === undefined ? undefined : validateOwnerControlOptions(scalars(record(pub["ownerControl"],
    ["socketPath", "requestTimeoutMs", "maxConnections"], "owner control configuration"), ["socketPath", "requestTimeoutMs", "maxConnections"],
    "owner control configuration") as unknown as NonNullable<HostServicesOptions["ownerControl"]>);
  const context = pub["context"] === undefined ? undefined : contextSnapshot(pub["context"]);
  const engineCommands = pub["engineCommands"] === undefined ? undefined : snapshotEngineCommands(pub["engineCommands"]);

  let relay: Readonly<RelayHostOptions> | undefined;
  let relayDescription: HostStartupDescription["relay"] = "unconfigured";
  if (providers["relay"] !== undefined) {
    const data = relayData(providers["relay"]);
    custodyAllowed(route, data.custodyMode);
    try { relay = validateRelayHostOptions(data); } catch { return refuse("Invalid relay provider."); }
    relayDescription = { status: "configured", custodyMode: relay.custodyMode, transportOwnership: relay.transportOwnership, persistentCustodyVerified: false };
  }
  let relayRecovery: HostRelayRecoveryOptions | undefined;
  let recoveryPin: Readonly<Record<string, unknown>> | null = null;
  let recoveryDescription: HostStartupDescription["relayRecovery"] = "unconfigured";
  if (providers["relayRecovery"] !== undefined) {
    const snap = recoverySnapshot(route, providers["relayRecovery"]);
    relayRecovery = snap.options; recoveryPin = snap.pin;
    recoveryDescription = { status: "configured", nextRecipient: snap.next, persistentCustodyVerified: false };
  }
  const managedApps = providers["managedApps"] !== undefined ? managedSnapshot(providers["managedApps"]) : undefined;
  const connections = providers["connections"] !== undefined ? connectionsSnapshot(providers["connections"]) : undefined;
  const makeDriver = top["makeDriver"] as HostServicesOptions["makeDriver"];

  // 2. Relay/recovery bind to the EXISTING installation identity; the store must never mint one for a provider.
  //    The captured identity is forwarded so the actual writer open is existing-only and re-admits it on its own handle.
  let existingInstallation: Readonly<{ installationId: string; ownerId: string }> | undefined;
  if (pub["existingInstallation"] !== undefined) {
    const expected = record(pub["existingInstallation"], ["installationId", "ownerId"], "existing installation");
    if (typeof expected["installationId"] !== "string" || typeof expected["ownerId"] !== "string") refuse("Invalid existing installation.");
    const identity = initializedIdentity(dataDir);
    if (expected["installationId"] !== identity.installationId || expected["ownerId"] !== identity.ownerId)
      refuse("Host identity does not match the existing installation.");
    existingInstallation = Object.freeze(identity);
  }
  if (relay || relayRecovery) {
    const identity = initializedIdentity(dataDir);
    existingInstallation = Object.freeze({ installationId: identity.installationId, ownerId: identity.ownerId });
    for (const pin of [relay?.recipient, recoveryPin]) {
      if (pin && (pin["installationId"] !== identity.installationId || pin["ownerId"] !== identity.ownerId))
        refuse("Relay recipient belongs to another installation or owner.");
    }
  }

  // Explicit construction: only snapshotted fields reach HostServices; no spread of caller objects.
  const options: HostServicesOptions = Object.freeze({
    dataDir,
    enableEngines: on("enableEngines"), enableMcp: on("enableMcp"), enableBotDelegation: on("enableBotDelegation"), enableDeviceTools: on("enableDeviceTools"), enableAgenda: on("enableAgenda"),
    ...(engineCommands ? { engineCommands } : {}), ...(nativeMcp ? { nativeMcp } : {}),
    ...(devices ? { devices } : {}), ...(appClients ? { appClients } : {}), ...(ownerControl ? { ownerControl } : {}),
    ...(context ? { context } : {}), ...(relay ? { relay } : {}), ...(relayRecovery ? { relayRecovery } : {}),
    ...(managedApps ? { managedApps } : {}), ...(connections ? { connections } : {}), ...(makeDriver ? { makeDriver } : {}),
    ...(existingInstallation ? { existingInstallation } : {}),
  });
  const description: HostStartupDescription = Object.freeze({
    route, dataDir, engines: on("enableEngines"), mcp: on("enableMcp"), deviceTools: on("enableDeviceTools"), agenda: on("enableAgenda"),
    nativeMcp: nativeMcp?.runsOn ?? "unconfigured",
    nativeMcpOAuthCustody: !nativeMcp ? "unconfigured" : nativeMcp.oauth ? "app_private_channel_unverified" : "memory",
    relay: relayDescription, relayRecovery: recoveryDescription, managedApps: managedApps ? "configured" : "unconfigured",
    connections: connections ? "configured" : "unconfigured",
  });
  let used = false;
  return Object.freeze({
    description,
    open(): HostServices {
      if (used) throw new HostError("conflict", "Startup plan was already used.");
      used = true;
      return new HostServices(options);
    },
  });
}
