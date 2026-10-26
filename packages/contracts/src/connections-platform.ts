import { z } from "zod";
import {
  CONNECTION_MANAGED_PROVIDERS, ConnectionIdentityConfirmationSchema, ConnectionIdentityCoreShape, ConnectionProviderAccountRefSchema, ConnectionServiceIdSchema,
  ConnectionTextSchema, connectionIdentityConsistent,
} from "./connections.js";
/** Identity as read by the trusted service (UX-P1-11): verified only from the reviewed official identity endpoint. */
export const PlatformIdentitySchema = z.strictObject(ConnectionIdentityCoreShape).refine(connectionIdentityConsistent);
export type PlatformIdentity = z.infer<typeof PlatformIdentitySchema>;

/**
 * Trusted connections service API (host ↔ service), version 1. Never exposed to the app, paired clients or engines.
 *
 * - The service holds provider project keys and webhook secrets; the host authenticates with a limited installation
 *   capability (`authorization: Bearer …` + `x-dexter-installation`). Installation/owner come from the capability,
 *   never from a body. The provider user namespace is derived by the service: `dx:<installation>:<owner>:<profile>`.
 * - Provider writes (authorization link, disconnect, execution) run at most once per (installation, requestId); a
 *   replay with the same request hash returns the recorded outcome and never repeats the provider write.
 * - `outcome: "unknown"` means the provider may have applied the write: the host reconciles with GET, never re-POSTs.
 */
export const CONNECTIONS_PLATFORM_VERSION = 1 as const;
export const CONNECTIONS_PLATFORM_INSTALLATION_HEADER = "x-dexter-installation";

const RequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ProfileId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Toolkit = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
/** Composio's published exact version (`YYYYMMDD_NN`). `latest` and floating tags are refused. */
export const ConnectionsToolkitVersionSchema = z.string().regex(/^\d{8}_\d{2}$/);
/** Bare https origin (no path, port, credentials, query or fragment). */
export const ConnectionsHttpsOriginSchema = z.string().max(260).regex(/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

export const PlatformCatalogEntrySchema = z.strictObject({
  serviceId: ConnectionServiceIdSchema,
  displayName: ConnectionTextSchema(80),
  description: z.string().max(280),
  provider: z.enum(CONNECTION_MANAGED_PROVIDERS),
  toolkit: Toolkit,
  toolkitVersion: ConnectionsToolkitVersionSchema,
  authorization: z.literal("oauth_link"),
  identity: ConnectionIdentityConfirmationSchema,
  verification: z.enum(["unproven", "proven"]),
  /** Origins the official authorization link may use. The host refuses any other link. */
  authorizationOrigins: z.array(ConnectionsHttpsOriginSchema).min(1).max(4),
  /** Reviewed Dexter gateway manifests (`upstreamHost` = this service). Validated by the host with the gateway rules. */
  tools: z.array(z.unknown()).min(1).max(32),
});
export type PlatformCatalogEntry = z.infer<typeof PlatformCatalogEntrySchema>;
export const PlatformCatalogSchema = z.strictObject({
  version: z.literal(CONNECTIONS_PLATFORM_VERSION),
  services: z.array(PlatformCatalogEntrySchema).max(64),
});
export type PlatformCatalog = z.infer<typeof PlatformCatalogSchema>;

export const PlatformAuthorizationRequestSchema = z.strictObject({
  requestId: RequestId,
  profileId: ProfileId,
  serviceId: ConnectionServiceIdSchema,
  catalogPin: Hash,
});
export type PlatformAuthorizationRequest = z.infer<typeof PlatformAuthorizationRequestSchema>;
export const PlatformAttemptStateSchema = z.enum(["starting", "awaiting_user", "active", "failed", "expired", "unknown"]);
export const PlatformAttemptSchema = z.strictObject({
  version: z.literal(CONNECTIONS_PLATFORM_VERSION),
  requestId: RequestId,
  requestHash: Hash,
  attemptId: z.string().regex(/^att_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  serviceId: ConnectionServiceIdSchema,
  profileId: ProfileId,
  catalogPin: Hash,
  state: PlatformAttemptStateSchema,
  reason: z.enum(["provider_failed", "provider_refused", "link_expired", "not_started", "outcome_unknown"]).nullable(),
  accountRef: ConnectionProviderAccountRefSchema.nullable(),
  expiresAt: Timestamp.nullable(),
  /** Browser return recorded by the service callback page. A hint only: confirmation comes from the provider read. */
  callback: z.enum(["none", "success", "failed"]),
  identity: PlatformIdentitySchema.nullable(),
});
export type PlatformAttempt = z.infer<typeof PlatformAttemptSchema>;
export const PlatformAuthorizationResponseSchema = z.strictObject({
  attempt: PlatformAttemptSchema,
  /** Only in the original creation response; the service does not persist or re-serve it. */
  authorizationURL: z.string().max(2048).nullable(),
});
export type PlatformAuthorizationResponse = z.infer<typeof PlatformAuthorizationResponseSchema>;

export const PlatformAccountStateSchema = z.enum(["active", "needs_reconnect", "pending", "revoked", "absent"]);
export const PlatformAccountSchema = z.strictObject({
  version: z.literal(CONNECTIONS_PLATFORM_VERSION),
  accountRef: ConnectionProviderAccountRefSchema,
  serviceId: ConnectionServiceIdSchema,
  profileId: ProfileId,
  state: PlatformAccountStateSchema,
  identity: PlatformIdentitySchema,
  checkedAt: Timestamp,
});
export type PlatformAccount = z.infer<typeof PlatformAccountSchema>;

export const PlatformDisconnectRequestSchema = z.strictObject({ requestId: RequestId });
export const PlatformDisconnectResultSchema = z.strictObject({
  version: z.literal(CONNECTIONS_PLATFORM_VERSION),
  requestId: RequestId,
  accountRef: ConnectionProviderAccountRefSchema,
  upstream: z.enum(["deleted", "already_absent"]),
  /** `requested`: the provider started a background revocation job (not pollable): never reported as confirmed. */
  revocation: z.enum(["requested", "not_requested"]),
});
export type PlatformDisconnectResult = z.infer<typeof PlatformDisconnectResultSchema>;

export const PlatformExecutionRequestSchema = z.strictObject({
  requestId: RequestId,
  profileId: ProfileId,
  accountRef: ConnectionProviderAccountRefSchema,
  serviceId: ConnectionServiceIdSchema,
  toolkit: Toolkit,
  slug: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  version: ConnectionsToolkitVersionSchema,
  arguments: z.record(z.string(), z.json()),
});
export type PlatformExecutionRequest = z.infer<typeof PlatformExecutionRequestSchema>;
export const PlatformExecutionResultSchema = z.strictObject({
  version: z.literal(CONNECTIONS_PLATFORM_VERSION), requestId: RequestId, data: z.json(),
});

/** Fixed error body. `outcome` tells whether a provider write may have happened. */
export const PlatformErrorSchema = z.strictObject({
  error: z.enum(["invalid_input", "unauthorized", "not_found", "conflict", "catalog_changed", "provider_refused", "rate_limited",
    "unavailable", "outcome_unknown", "duplicate"]),
  outcome: z.enum(["not_applied", "unknown"]),
});
export type PlatformError = z.infer<typeof PlatformErrorSchema>;
