import { z } from "zod";

/**
 * Owner-private configuration of the trusted connections service (Conectar apps), owner-loopback contract.
 *
 * - Persisted METADATA only: the service origin chosen by the owner, the enable intent and a credential generation.
 *   The installation capability (the secret behind `credentialRef`) is never part of this contract: it lives in the
 *   app's Keychain custody and reaches the host only over the app-owned private pipe (frames below), held in memory.
 * - The origin is the owner's own deployment of the connections service: `https://<dns-name>`, no port, path, query,
 *   userinfo or IP literal (the same rule as the host client's origin check). No Dexter cloud URL exists or is implied.
 * - Saving is not connecting: `runtime` says whether the running host composed the service from this configuration;
 *   connectivity is only what `/v1/connections/status` and the catalog report after a real read.
 * - CAS by `expectedRevision`, receipt by `clientRequestId` (same id + same body → same receipt; other body → 409),
 *   uncertain outcome settled by GET of the original receipt only.
 */
export const CONNECTIONS_CONFIGURATION_VERSION = 1 as const;
/** Fixed broker reference of the installation capability composed from this configuration. Never a request field. */
export const CONNECTIONS_PLATFORM_CREDENTIAL_REF = "connections-platform" as const;
/** App → host private frame (owned stdin pipe only) and its fixed acknowledgement (owned stdout pipe only). */
export const CONNECTIONS_CAPABILITY_FRAME_SCHEMA = "dexter.connections-capability/1" as const;
export const CONNECTIONS_CAPABILITY_ACK_SCHEMA = "dexter.connections-capability-ack/1" as const;
/** Installation capability shape accepted by the host client (`Authorization: Bearer`). */
export const CONNECTIONS_CAPABILITY_PATTERN = /^[A-Za-z0-9._~+/=-]{32,512}$/;

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** Exact `https://<lowercase dns name>`; refuses ports, paths, queries, credentials, IP literals and localhost names. */
export function isTrustedConnectionsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10 || value.length > 300) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" || url.origin !== value) return false;
  const host = url.hostname, labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || host === "localhost" || host.endsWith(".localhost") || host.startsWith("[")) return false;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return false;
  return labels.every(label => DNS_LABEL.test(label));
}

const HostId = z.string().min(1).max(128);
const Revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const RequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const ConnectionsPlatformOriginSchema = z.string().refine(isTrustedConnectionsOrigin, "Trusted HTTPS service origin required.");

export const SetConnectionsConfigurationSchema = z.strictObject({
  expectedHostId: HostId,
  clientRequestId: RequestId,
  expectedRevision: Revision,
  origin: ConnectionsPlatformOriginSchema.nullable(),
  enabled: z.boolean(),
  /** Starts a new credential generation (the previous capability is no longer accepted). Origin changes always do. */
  renewCredential: z.boolean(),
}).refine(value => !value.enabled || value.origin !== null, "Enabling requires an origin.");
export type SetConnectionsConfiguration = z.infer<typeof SetConnectionsConfigurationSchema>;

export const ConnectionsConfigurationSchema = z.strictObject({
  revision: Revision,
  generation: Revision,
  origin: ConnectionsPlatformOriginSchema.nullable(),
  enabled: z.boolean(),
  credentialRef: z.literal(CONNECTIONS_PLATFORM_CREDENTIAL_REF),
  updatedAt: z.number().int().min(0).nullable(),
}).refine(value => !value.enabled || value.origin !== null, "Enabled configuration requires an origin.");
export type ConnectionsConfiguration = z.infer<typeof ConnectionsConfigurationSchema>;

export const CONNECTIONS_RUNTIME_STATES = ["inactive", "active", "restart_required", "configured_externally"] as const;
/** Why the running host did not compose the service from this configuration (closed set). */
export const CONNECTIONS_RUNTIME_REASONS = ["disabled", "private_channel_unavailable", "requires_mcp_engines", "exclusive_upstream",
  "origin_bound_to_other_connections", "configuration_unavailable"] as const;
export const ConnectionsRuntimeStateSchema = z.strictObject({
  state: z.enum(CONNECTIONS_RUNTIME_STATES),
  reason: z.enum(CONNECTIONS_RUNTIME_REASONS).nullable(),
  /** Origin/generation the running service was composed with (null when none was composed from this configuration). */
  origin: ConnectionsPlatformOriginSchema.nullable(),
  generation: Revision.nullable(),
}).refine(value => value.state === "active" ? value.reason === null && value.origin !== null && value.generation !== null
  : value.state === "inactive" ? value.reason !== null && value.origin === null && value.generation === null
  : value.state === "configured_externally" ? value.reason === null && value.generation === null : true, "Inconsistent runtime state.");

export const ConnectionsCustodyStateSchema = z.strictObject({
  channel: z.enum(["app_private_channel", "unavailable"]),
  state: z.enum(["absent", "ready", "locked"]),
  generation: Revision.nullable(),
}).refine(value => (value.channel === "unavailable" ? value.state === "absent" : true) && (value.state === "ready") === (value.generation !== null),
  "Inconsistent custody state.");

export const ConnectionsPrivateRequestSchema = z.strictObject({
  requestId: UUID,
  operation: z.enum(["set", "lock"]),
  generation: Revision,
  state: z.enum(["ready", "locked", "refused"]),
});

export const ConnectionsConfigurationStatusSchema = z.strictObject({
  version: z.literal(CONNECTIONS_CONFIGURATION_VERSION),
  hostId: HostId,
  ownerId: HostId,
  configuration: ConnectionsConfigurationSchema,
  runtime: ConnectionsRuntimeStateSchema,
  custody: ConnectionsCustodyStateSchema,
  /** The last private frame this host process settled (no secret); resolves a lost acknowledgement by GET only. */
  privateRequest: ConnectionsPrivateRequestSchema.nullable(),
});
export type ConnectionsConfigurationStatus = z.infer<typeof ConnectionsConfigurationStatusSchema>;

export const ConnectionsConfigurationReceiptSchema = z.strictObject({
  hostId: HostId,
  ownerId: HostId,
  clientRequestId: RequestId,
  /** SHA-256 of the canonical (sorted-key) JSON of the exact request body. */
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  previousRevision: Revision,
  previousGeneration: Revision,
  configuration: ConnectionsConfigurationSchema,
  /** The running host does not use this configuration until it restarts (computed when committed). */
  restartRequired: z.boolean(),
  committedAt: z.number().int().min(0),
});
export type ConnectionsConfigurationReceipt = z.infer<typeof ConnectionsConfigurationReceiptSchema>;

export const ConnectionsConfigurationResultSchema = z.strictObject({
  receipt: ConnectionsConfigurationReceiptSchema,
  status: ConnectionsConfigurationStatusSchema,
});
