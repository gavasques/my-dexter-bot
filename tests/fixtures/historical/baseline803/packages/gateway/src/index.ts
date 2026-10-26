export { GatewayError, type GatewayErrorCode } from "./errors.js";
export {
  checkManifest, manifestHash, validateArguments, validateCall,
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
