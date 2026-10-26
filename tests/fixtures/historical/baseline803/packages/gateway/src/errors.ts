import { readMcpSetupDiagnostic, type McpSetupDiagnostic } from "@dexter/contracts";
export type GatewayErrorCode =
  | "unauthorized" | "forbidden" | "invalid_input" | "not_found" | "conflict" | "meta_tool_refused" | "unavailable";

/**
 * Gateway errors carry a fixed code and a message built only from trusted names (schema property names,
 * fixed reasons). Never argument values, upstream errors or credential material.
 */
export class GatewayError extends Error {
  readonly diagnostic: McpSetupDiagnostic | null;
  constructor(readonly code: GatewayErrorCode, message: string, diagnostic?: McpSetupDiagnostic | null) {
    super(message);
    this.name = "GatewayError";
    this.diagnostic = readMcpSetupDiagnostic(diagnostic);
  }
}
