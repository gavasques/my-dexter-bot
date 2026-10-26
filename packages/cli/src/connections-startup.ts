import { SCHEMA_VERSION } from "@dexter/hub";
import { CONNECTIONS_PLATFORM_CREDENTIAL_REF, CONNECTIONS_RUNTIME_REASONS } from "@dexter/contracts";
import type { FetchLike } from "@dexter/connectors";
import { readHubIdentity, readSourceAuthority } from "@dexter/operations";
import { originBoundElsewhere, readConnectionsConfigurationForStartup, type ConnectionsComposition, type ConnectionsPrivateEnvironment } from "./connections-configuration.js";
import { ConnectionsCapabilityVault } from "./connections-private-custody.js";
import type { HostStartupProviders } from "./host-startup.js";

/**
 * Private owner path into `planHostStartup` → `providers.connections` (the app-launched `dexter serve`).
 *
 * Reads, before the plan and without writing, the owner's persisted configuration of THIS existing installation
 * (canonical identity + active authority). Composes the trusted provider only when every condition holds: the
 * app-owned private channel exists (stdin FIFO + owned stdout pipe), MCP engines are enabled, no other exclusive
 * upstream is configured, the configuration is enabled with an origin, and any existing `connections.sqlite` is bound
 * to that same origin. The capability is NOT here: the provider reads it per request from the in-memory vault that only
 * the private pipe fills, for this exact origin + credential generation. Otherwise nothing is composed and the reason
 * stays visible (`unconfigured` service; never a fallback provider, origin or credential).
 */
export interface ConnectionsPrivateStartupInput {
  dataDir: string;
  channel: boolean;
  enableMcp: boolean;
  enableEngines: boolean;
  exclusiveUpstream: boolean;
  /** The trusted embedding's fetch (the executable passes the system fetch captured at load). */
  fetch: FetchLike;
}
export interface ConnectionsPrivateStartup {
  readonly environment: Readonly<ConnectionsPrivateEnvironment>;
  readonly provider: NonNullable<HostStartupProviders["connections"]> | undefined;
  /** Present iff the private channel exists (a vault without a composed service refuses every capability). */
  readonly vault: ConnectionsCapabilityVault | undefined;
  readonly composition: ConnectionsComposition;
  /** Startup reason when nothing was composed (null when composed or when no configuration exists). */
  readonly reason: (typeof CONNECTIONS_RUNTIME_REASONS)[number] | null;
}

function existingIdentity(dataDir: string): { hostId: string; ownerId: string } | null {
  try {
    const hub = readHubIdentity(dataDir), authority = readSourceAuthority(dataDir);
    if (hub.schemaVersion !== SCHEMA_VERSION || authority.schemaVersion !== SCHEMA_VERSION || authority.state !== "active"
      || authority.installationId !== hub.installationId || authority.ownerId !== hub.ownerId) return null;
    return { hostId: hub.installationId, ownerId: hub.ownerId };
  } catch { return null; }
}

export function planConnectionsPrivateStartup(input: ConnectionsPrivateStartupInput): ConnectionsPrivateStartup {
  const environment = Object.freeze({ channel: input.channel === true, mcpEngines: input.enableMcp === true && input.enableEngines === true,
    exclusiveUpstream: input.exclusiveUpstream === true });
  const none = (reason: ConnectionsPrivateStartup["reason"]): ConnectionsPrivateStartup => Object.freeze({ environment, provider: undefined,
    vault: environment.channel ? new ConnectionsCapabilityVault(null) : undefined, composition: null, reason });
  if (typeof input.fetch !== "function") return none("configuration_unavailable");
  // A fresh data directory has no installation yet, hence no owner configuration: identity is never generated here.
  const identity = existingIdentity(input.dataDir);
  if (!identity) return none(null);
  let configuration;
  try { configuration = readConnectionsConfigurationForStartup(input.dataDir, identity); }
  catch { return none("configuration_unavailable"); }
  if (!configuration) return none(null);
  if (!configuration.enabled || configuration.origin === null) return none("disabled");
  if (!environment.channel) return none("private_channel_unavailable");
  if (!environment.mcpEngines) return none("requires_mcp_engines");
  if (environment.exclusiveUpstream) return none("exclusive_upstream");
  const origin = configuration.origin;
  try { if (originBoundElsewhere(input.dataDir, origin)) return none("origin_bound_to_other_connections"); }
  catch { return none("configuration_unavailable"); }
  const vault = new ConnectionsCapabilityVault({ origin, generation: configuration.generation });
  const fetch = input.fetch;
  const provider = Object.freeze({
    credentialRef: CONNECTIONS_PLATFORM_CREDENTIAL_REF,
    platform: Object.freeze({ origin, capability: () => vault.capability(), fetch: (url: string, init: RequestInit) => fetch(url, init) }),
  }) as NonNullable<HostStartupProviders["connections"]>;
  return Object.freeze({ environment, provider, vault, composition: Object.freeze({ source: "owner_private" as const, origin, generation: configuration.generation }), reason: null });
}
