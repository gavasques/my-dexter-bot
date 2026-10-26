export { GatewayError, type GatewayErrorCode } from "./errors.js";
export {
  checkManifest, manifestHash, validateArguments, validateCall, checkNativeMcpSchema, checkNativeMcpArguments,
  type ToolManifest, type InputSchema, type ArgumentSchema, type ScalarSchema,
} from "./manifest.js";
export { SyntheticCredentialBroker, type CredentialBroker, type InjectedAuth } from "./broker.js";
export {
  GatewayRegistry, GATEWAY_DATABASE_FILE, type Connection, type ConnectInput, type RegisteredTool, type WriterLease,
} from "./registry.js";
export {
  CapabilityGateway, type AdapterCall, type UpstreamAdapter, type GatewayOptions, type CapabilityScope,
  type GatewayCallInput, type GatewayCallResult, type ToolView,
} from "./gateway.js";
export { GatewayMcpBridge, MCP_PROTOCOL_VERSION, type GatewayMcpOptions } from "./mcp.js";
export { McpTurnLease, prepareMcpTurn, MCP_SERVER_NAME, type McpTurnOptions, type NativeMcpServer } from "./mcp-turn.js";

export type { TurnToolSurface } from "./surface.js";
export { MCP_AUTHORIZED_INVENTORY_LIMIT, gatewayToolAlias, gatewayConnectionTag, planCatalogExposure, projectCatalogTool, searchCatalog, estimateCatalogTokens,
  directoryToolDefinitions, MCP_DIRECTORY_ALIASES, skillConnectionEligibility, type CatalogExposure, type CatalogExposureOptions } from "./catalog.js";
export { MCP_LEGACY_VERSION, MCP_MODERN_VERSION, MCP_SUPPORTED_VERSIONS, modernMetadata, classifyMcpEraProbe, McpProtocolError,
  encodeMcpHeaderValue, decodeMcpHeaderValue, mcpHeaderAnnotations, buildModernMcpHeaders, validateModernMcpHeaders, McpMrtrVault, type MrtrBinding } from "./protocol.js";
export { projectMcpOutcome, mcpSemanticError, mcpResultContent, type McpArtifactSink, type McpArtifactSinkInput, type McpOutputBudget } from "./output.js";

// Shared, closed native schema admission; never rewrites an upstream definition.
export { nativeMcpSchemaResourceWeight, NATIVE_MCP_SCHEMA_RESOURCE_LIMITS, type NativeMcpSchemaResourceWeight } from "./native-schema-admission.js";
