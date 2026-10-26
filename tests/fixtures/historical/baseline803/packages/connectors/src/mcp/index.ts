export { McpConnectorError, type McpErrorCode } from "./errors.js";
export { normalizeMcpHttpRegistration, type McpHttpRegistration } from "./http-registration.js";
export {
  McpServerInventory, checkMcpDefinition, mcpConnectInput, mcpLogicalHost, mcpToolkit, mcpAccountRef, MCP_DEFAULT_LIMITS,
  type McpServerDefinition, type McpServerSource, type McpTransport, type McpStdioTransport, type McpHttpTransport, type McpValue, type McpLimits,
} from "./definition.js";
export {
  previewClaudeMcpJson, previewCodexToml, looksSecret,
  type McpImportPreview, type McpImportedServer, type McpImportStatus, type McpImportFormat, type McpCredentialSlot,
} from "./import.js";
export { McpUpstreamSession, type McpRuntimeHost, type McpCredential, type McpDiscoveredTool } from "./session.js";
export {
  planMcpTools, toGatewaySchema, mcpToolName, McpToolCatalog, McpCatalogSet,
  type McpToolPlan, type McpCatalogEntry, type McpCatalogSource,
} from "./catalog.js";
export { McpToolAdapter, probeMcpServer, type McpAdapterOptions, type McpProbeResult } from "./adapter.js";
export {
  NativeMcpRuntime, NATIVE_MCP_DATABASE_FILE, isNativeMcpHost, isNativeMcpCredentialRef,
  type NativeMcpAdmin, type NativeMcpHost, type NativeMcpRuntimeOptions, type McpServerSummary, type McpToolSummary, type McpBotSelection,
  type McpCredentialStatus,
} from "./manager.js";
export { McpBrokerVault, onePasswordMcpCustody, secretSlotsOf, type McpSecretCustody, type McpVaultStatus } from "./credentials.js";
export {
  McpOAuthClient, MemoryMcpOAuthTokenStore, MCP_OAUTH_ACCESS_KEY, oauthResourceOf,
  type McpOAuthTokens, type McpOAuthTokenStore, type McpOAuthOptions, type McpOAuthStart, type McpOAuthState,
} from "./oauth.js";

// Shared Root composition overlay: pure persisted-journal validators, no OAuth/session construction.
export { NATIVE_MCP_RECEIPT_LIMIT, NATIVE_MCP_RECEIPTS_SQL, validateMcpSetupReceipts,
  readMcpSetupReceiptRow, mcpSetupHash } from "./setup-receipts.js";

// Root-owned public-wiring overlay: original native receipt hash domains, no runtime/session construction.
export { mcpSetupCanonicalJSON, mcpSetupOriginHash, mcpSetupRequestHash, mcpSetupInstancePin } from "./setup-receipts.js";

// Root-owned Native3 compatibility and focused instance-selection API overlay.
export { MCP_INSTANCE_SELECTION_SQL, MCP_INSTANCE_SELECTION_RECEIPT_LIMIT, MCP_INSTANCE_SELECTION_HEAD_LIMIT,
 validateMcpInstanceSelectionSchema, validateMcpInstanceSelectionRows, readMcpInstanceSelectionRow } from "./instance-selection-journal.js";
export type { McpInstanceSelectionReview, McpInstanceSelectionOutcome } from "./manager.js";
