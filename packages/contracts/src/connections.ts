import { z } from "zod";

/**
 * App connections (UX-P1-09): owner-loopback contract between the Apple app and the host.
 *
 * One experience per service and account: catalog → authorization in the official flow → account confirmed by the
 * backend → bots authorized by the owner. Connecting never grants a bot anything; bot access is a separate owner
 * mutation with expected revision, client request id and receipt. Provider, transport and revision details are
 * diagnostics, never a required user choice.
 *
 * The managed route reaches providers only through the trusted connections service (project keys and webhook secrets
 * stay there); the host holds a limited installation capability. The direct route is the existing native MCP manager.
 * Provider ids form a CLOSED set: a provider without an explicit Dexter adapter (Pipedream, Nango, ...) cannot appear.
 */
export const CONNECTIONS_CONTRACT_VERSION = 1 as const;
/** Managed providers with an implemented Dexter adapter. Extending this list requires a new adapter, never data. */
export const CONNECTION_MANAGED_PROVIDERS = ["composio"] as const;
export type ConnectionManagedProvider = typeof CONNECTION_MANAGED_PROVIDERS[number];

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** UTF-16 well-formed, no C0/C1 controls. Labels are display data, never identity proof. */
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export const ConnectionTextSchema = (max: number) => z.string().min(1).max(max).refine(wellFormed, "Text must be well-formed without control characters.");
const RequestId = z.string().regex(ID);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const HostId = z.string().min(1).max(128);
const BotId = z.string().regex(ID);
const ProfileId = z.string().min(1).max(128);

export const ConnectionServiceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
/** Host-issued ids. `acct_` managed accounts; `mcp_<instance>` projections of native MCP instances (direct route). */
export const ConnectionAccountIdSchema = z.string().regex(new RegExp(`^(?:acct_${UUID4}|mcp_[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)$`));
export const ConnectionAuthorizationIdSchema = z.string().regex(new RegExp(`^auth_${UUID4}$`));
/** Upstream connected-account reference (e.g. Composio `ca_...`). Technical detail; never an engine argument. */
export const ConnectionProviderAccountRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const ConnectionToolNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);

export const ConnectionRouteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("managed"), provider: z.enum(CONNECTION_MANAGED_PROVIDERS) }),
  z.strictObject({ kind: z.literal("direct_mcp") }),
]);
export type ConnectionRoute = z.infer<typeof ConnectionRouteSchema>;

/**
 * Identity levels (UX-P1-11). `provider_verified`: value read from the provider's OFFICIAL identity endpoint with the
 * account's own authorized access, reviewed endpoint and destination. `provider_display_name`: provider label only (not a
 * verified email). `unconfirmed`: the route exposes no identity; only ids are shown. Never derived from a user label,
 * alias, account id or a matching URL.
 */
export const ConnectionIdentityConfirmationSchema = z.enum(["provider_verified", "provider_display_name", "unconfirmed"]);
export const ConnectionIdentityKindSchema = z.enum(["email", "username", "workspace", "tenant", "display_name"]);
export const ConnectionIdentitySourceSchema = z.enum(["identity_endpoint", "provider_label"]);
/** Shape shared by host and trusted service; levels and sources must agree. */
export const ConnectionIdentityCoreShape = {
  confirmation: ConnectionIdentityConfirmationSchema,
  value: ConnectionTextSchema(254).nullable(),
  kind: ConnectionIdentityKindSchema.nullable(),
  source: ConnectionIdentitySourceSchema.nullable(),
};
export function connectionIdentityConsistent(v: { confirmation: string; value: string | null; kind: string | null; source: string | null }): boolean {
  if (v.confirmation === "unconfirmed") return v.value === null && v.kind === null && v.source === null;
  if (v.confirmation === "provider_display_name") return v.value !== null && v.kind === "display_name" && v.source === "provider_label";
  return v.value !== null && v.kind !== null && v.kind !== "display_name" && v.source === "identity_endpoint";
}
export const ConnectionIdentitySchema = z.strictObject({
  ...ConnectionIdentityCoreShape,
  /** Direct OAuth: the validated authorization-server issuer (who issued the tokens), not the account identity. */
  issuer: z.string().max(2048).nullable(),
  /** Last time the provider confirmed this identity; null when never confirmed. */
  checkedAt: Timestamp.nullable(),
}).refine(connectionIdentityConsistent, "Identity level, value, kind and source must agree.");
export type ConnectionIdentity = z.infer<typeof ConnectionIdentitySchema>;
export const ConnectionPlatformStateSchema = z.enum(["unconfigured", "available", "unavailable"]);
export const ConnectionToolSummarySchema = z.strictObject({
  name: ConnectionToolNameSchema, description: ConnectionTextSchema(280), effect: z.enum(["read", "write"]),
  manifestHash:Hash.optional(),
});

export const ConnectionCatalogEntrySchema = z.strictObject({
  serviceId: ConnectionServiceIdSchema,
  displayName: ConnectionTextSchema(80),
  description: z.string().max(280).refine(wellFormed),
  route: ConnectionRouteSchema,
  authorization: z.enum(["oauth_link"]),
  identity: ConnectionIdentityConfirmationSchema,
  tools: z.array(ConnectionToolSummarySchema).min(1).max(32),
  /** Operator-recorded real login + authorized operation proof for this integration. `unproven` is not "Disponível". */
  verification: z.enum(["unproven", "proven"]),
  availability: z.strictObject({
    state: z.enum(["available", "unavailable"]),
    reason: z.enum(["platform_unconfigured", "platform_unavailable", "no_eligible_profile"]).nullable(),
  }),
});
export type ConnectionCatalogEntry = z.infer<typeof ConnectionCatalogEntrySchema>;
export const ConnectionCatalogSchema = z.strictObject({
  version: z.literal(CONNECTIONS_CONTRACT_VERSION),
  hostId: HostId,
  platform: ConnectionPlatformStateSchema,
  /** Host-local snapshot revision of the trusted service catalog; 0 means never fetched. */
  revision: Revision,
  pin: Hash.nullable(),
  fetchedAt: Timestamp.nullable(),
  freshness: z.enum(["fresh", "stale", "never"]),
  services: z.array(ConnectionCatalogEntrySchema).max(64),
});
export type ConnectionCatalog = z.infer<typeof ConnectionCatalogSchema>;

export const ConnectionAuthorizationStateSchema = z.enum([
  "starting", "awaiting_user", "verifying", "connected", "failed", "expired", "cancelled", "mismatch", "unknown",
]);
export type ConnectionAuthorizationState = z.infer<typeof ConnectionAuthorizationStateSchema>;
/** Fixed reason codes; never upstream/provider text. */
export const ConnectionAuthorizationReasonSchema = z.enum([
  "user_cancelled", "provider_failed", "provider_refused", "link_expired", "account_mismatch", "outcome_unknown",
  "catalog_changed", "platform_unavailable", "not_started", "link_not_recoverable",
]);
export const StartConnectionAuthorizationSchema = z.strictObject({
  expectedHostID: HostId,
  clientRequestId: RequestId,
  serviceId: ConnectionServiceIdSchema,
  /** Pin of the catalog the owner saw. A different current pin refuses with `conflict` (refresh, then confirm again). */
  catalogPin: Hash,
  /** Null derives the single profile shared by this owner's bots; several profiles require an explicit one. */
  profileId: ProfileId.nullable(),
  label: ConnectionTextSchema(80).nullable(),
  /** Reconnect: a NEW account is created. Bot access never transfers implicitly. */
  replacesAccountId: ConnectionAccountIdSchema.nullable(),
  /** Correlated first-party setup request; does not grant access or change provider identity. */
  setupRequestId:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
});
export type StartConnectionAuthorization = z.infer<typeof StartConnectionAuthorizationSchema>;
export const ConnectionAuthorizationSchema = z.strictObject({
  version: z.literal(CONNECTIONS_CONTRACT_VERSION),
  hostId: HostId,
  id: ConnectionAuthorizationIdSchema,
  clientRequestId: RequestId,
  requestHash: Hash,
  serviceId: ConnectionServiceIdSchema,
  route: ConnectionRouteSchema,
  catalogRevision: Revision,
  catalogPin: Hash,
  profileId: ProfileId,
  state: ConnectionAuthorizationStateSchema,
  reason: ConnectionAuthorizationReasonSchema.nullable(),
  /** Transient official authorization link: present only while `awaiting_user` and held in host memory. Never persisted. */
  authorizationURL: z.string().url().max(2048).nullable(),
  linkAvailable: z.boolean(),
  expiresAt: Timestamp.nullable(),
  callback: z.enum(["none", "returned", "cancelled"]),
  accountId: ConnectionAccountIdSchema.nullable(),
  setupRequestId:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
  replacesAccountId: ConnectionAccountIdSchema.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ConnectionAuthorization = z.infer<typeof ConnectionAuthorizationSchema>;
/**
 * Owner signal that the official flow returned (or was cancelled). It is a hint to reconcile with the provider,
 * never proof of an account and never a grant. A provider account reference that differs from the one issued for
 * this authorization ends it as `mismatch`.
 */
export const ConnectionAuthorizationCallbackSchema = z.strictObject({
  expectedHostID: HostId,
  outcome: z.enum(["returned", "cancelled"]),
  providerAccountRef: ConnectionProviderAccountRefSchema.nullable(),
});
export type ConnectionAuthorizationCallback = z.infer<typeof ConnectionAuthorizationCallbackSchema>;

/** `identity_mismatch`: the provider now reports a different verified identity for this account; it was stopped (fail closed). */
export const ConnectionAccountStatusSchema = z.enum(["connected", "needs_reconnect", "disconnecting", "disconnected", "replaced", "identity_mismatch", "unknown"]);
export const ConnectionBotAccessSchema = z.strictObject({
  botId: BotId,
  /** Derived from the hub grants of every pinned tool on this account: the grant authority, not a cached flag. */
  access: z.enum(["enabled", "disabled", "partial"]),
  /** Exact current usable tools on THIS account, derived from current canonical grants. */
  toolNames:z.array(ConnectionToolNameSchema).max(32).optional(),
});
export const ConnectionUpstreamDisconnectSchema = z.strictObject({
  upstream: z.enum(["not_requested", "deleted", "already_absent", "unknown"]),
  revocation: z.enum(["not_requested", "requested", "unknown"]),
});
export const ConnectionAccountSchema = z.strictObject({
  version: z.literal(CONNECTIONS_CONTRACT_VERSION),
  hostId: HostId,
  id: ConnectionAccountIdSchema,
  serviceId: ConnectionServiceIdSchema,
  displayName: ConnectionTextSchema(80),
  route: ConnectionRouteSchema,
  label: ConnectionTextSchema(80),
  /** Value only from a validated provider response; never derived from the label, alias or endpoint. */
  identity: ConnectionIdentitySchema,
  status: ConnectionAccountStatusSchema,
  statusCheckedAt: Timestamp.nullable(),
  /**
   * `app_keychain`: native OAuth tokens confirmed in the app's Data Protection Keychain custody (UX-P1-10).
   * `volatile_until_host_restart`: tokens only in host memory (custody absent, unverified or refused).
   */
  persistence: z.enum(["managed_service", "volatile_until_host_restart", "app_keychain", "host_persistent"]),
  /** `native_mcp`: operations stay on the native MCP routes; this item is a read-only projection. */
  manage: z.enum(["connections", "native_mcp"]),
  nativeServerId: z.string().max(40).nullable(),
  revision: Revision,
  profileId: ProfileId.nullable(),
  tools: z.array(z.strictObject({ name: ConnectionToolNameSchema, effect: z.enum(["read", "write"]), manifestHash: Hash.optional() })).max(32),
  bots: z.array(ConnectionBotAccessSchema).max(500),
  previousAccountId: ConnectionAccountIdSchema.nullable(),
  /** Gateway destinations of this account (action `destination`), so proposals/results can name the account used. */
  gatewayConnectionIds: z.array(z.string().regex(ID)).max(32),
  /** True/false only when both accounts have a provider display name; null when it cannot be compared. */
  identityChanged: z.boolean().nullable(),
  disconnect: ConnectionUpstreamDisconnectSchema.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ConnectionAccount = z.infer<typeof ConnectionAccountSchema>;
export const ConnectionAccountsSchema = z.strictObject({
  version: z.literal(CONNECTIONS_CONTRACT_VERSION), hostId: HostId, items: z.array(ConnectionAccountSchema).max(200),
});
export type ConnectionAccounts = z.infer<typeof ConnectionAccountsSchema>;

/** Owner-only CAS on the account revision. `enabled` grants `ask` on every pinned tool; approval modes still apply. */
export const SetConnectionBotAccessSchema = z.strictObject({
  expectedHostID: HostId, clientRequestId: RequestId, expectedRevision: Revision.max(Number.MAX_SAFE_INTEGER - 1),
  botId: BotId, enabled: z.boolean(),
  /** Exact current snapshot; absent preserves legacy all-tools behavior for this pinned account only. */
  toolNames:z.array(ConnectionToolNameSchema).max(32).refine(v=>new Set(v).size===v.length).optional(),
});
export type SetConnectionBotAccess = z.infer<typeof SetConnectionBotAccessSchema>;
/** Local revocation first (blocks the connection's pending work), then one provider delete. No rollback is claimed. */
export const DisconnectConnectionAccountSchema = z.strictObject({
  expectedHostID: HostId, clientRequestId: RequestId, expectedRevision: Revision.max(Number.MAX_SAFE_INTEGER - 1),
});
export type DisconnectConnectionAccount = z.infer<typeof DisconnectConnectionAccountSchema>;
export const ConnectionReceiptSchema = z.strictObject({
  version: z.literal(CONNECTIONS_CONTRACT_VERSION),
  hostId: HostId,
  clientRequestId: RequestId,
  kind: z.enum(["access", "disconnect", "label"]),
  accountId: ConnectionAccountIdSchema,
  requestHash: Hash,
  previousRevision: Revision,
  revision: Revision,
  /** Absent in historical receipts means applied. Recovery never repeats the original grant batch. */
  accessOutcome: z.enum(["applied", "not_applied", "superseded"]).optional(),
  access: z.strictObject({ botId: BotId, enabled: z.boolean(), tools: z.number().int().min(0).max(32),toolNames:z.array(ConnectionToolNameSchema).max(32).optional() }).nullable(),
  disconnect: ConnectionUpstreamDisconnectSchema.nullable(),
  label: ConnectionTextSchema(80).nullable(),
  createdAt: Timestamp,
});
export type ConnectionReceipt = z.infer<typeof ConnectionReceiptSchema>;
/** Owner-editable friendly name (display only). The name engines see stays fixed at confirmation (service · identity). */
export const SetConnectionLabelSchema = z.strictObject({
  expectedHostID: HostId, clientRequestId: RequestId, expectedRevision: Revision.max(Number.MAX_SAFE_INTEGER - 1), label: ConnectionTextSchema(80),
});
export type SetConnectionLabel = z.infer<typeof SetConnectionLabelSchema>;

export const ConnectionsStatusSchema = z.strictObject({
  version: z.literal(CONNECTIONS_CONTRACT_VERSION),
  hostId: HostId,
  platform: ConnectionPlatformStateSchema,
  managedProviders: z.array(z.enum(CONNECTION_MANAGED_PROVIDERS)).max(CONNECTION_MANAGED_PROVIDERS.length),
  direct: z.enum(["native_mcp", "unconfigured"]),
  nativeOAuthPersistence: z.enum(["volatile", "persistent", "unconfigured"]),
  openAuthorizations: z.number().int().min(0).max(10_000),
});
export type ConnectionsStatus = z.infer<typeof ConnectionsStatusSchema>;
