import { ToolExecutionFailure } from "@dexter/contracts";
export type McpErrorCode =
  | "metadata_quarantined" | "schema_unsupported" | "input_schema_invalid" | "output_schema_invalid" | "validation_resource_limit"
  | "egress_refused" | "protocol_unsupported" | "header_mismatch" | "input_required" | "circuit_open" | "command_changed"
  | "endpoint_invalid" | "endpoint_secret_refused"
  // definition, import and authority (refused before anything starts or leaves the process)
  | "invalid_definition" | "import_invalid" | "import_unsupported" | "server_unknown" | "placement_unavailable"
  | "scope_mismatch" | "tool_not_allowed" | "tool_changed" | "arguments_refused" | "credential_missing"
  // authorization the runtime cannot complete yet (OAuth or another interactive step)
  | "needs_auth"
  // transport and upstream (a call may have reached upstream: the effect is ambiguous)
  | "spawn_failed" | "connect_failed" | "timeout" | "aborted" | "transport_failed" | "upstream_redirect"
  | "origin_refused" | "upstream_status" | "upstream_error" | "response_too_large" | "response_invalid" | "closed"
  // owner administration of the persistent connection manager (fixed answers, nothing upstream involved)
  | "invalid_request" | "server_exists" | "server_limit" | "secret_refused" | "bot_unknown" | "catalog_unavailable"
  | "busy" | "unbound" | "store_conflict"
  // credential custody (broker) and local OAuth: fixed answers, never a value, reference, URL query or upstream text
  | "custody_unavailable" | "credential_locked" | "credential_refused" | "oauth_unavailable" | "oauth_client_required"
  | "oauth_metadata_invalid" | "oauth_flow_failed" | "oauth_denied" | "oauth_state_mismatch" | "oauth_expired";

/**
 * Native MCP errors carry a fixed code and a fixed message. Never server output, stderr, argument values,
 * environment or header values, command lines or parser messages (which can quote the input).
 * `detail` is an optional fixed-vocabulary hint (for example a definition field name), never input content.
 */
export class McpConnectorError extends Error {
  readonly phase: "configuration" | "connect" | "discovery" | "pre_dispatch" | "dispatch" | "validation";
  readonly effect: "none" | "possible";
  readonly metadataHash: string | null;
  constructor(readonly code: McpErrorCode, readonly detail: string | null = null, readonly status: number | null = null,
    diagnostic?: { phase: McpConnectorError["phase"]; effect: McpConnectorError["effect"]; metadataHash?: string }) {
    super(`mcp: ${code}${detail === null ? "" : ` (${detail})`}${status === null ? "" : ` [${status}]`}`,
      code === "validation_resource_limit" ? { cause: new ToolExecutionFailure(code, diagnostic?.effect === "possible" ? "after_dispatch" : "before_dispatch") } : undefined);
    this.name = "McpConnectorError";
    this.phase = diagnostic?.phase ?? "configuration";
    this.effect = diagnostic?.effect ?? "none";
    this.metadataHash = diagnostic?.metadataHash && /^[a-f0-9]{64}$/.test(diagnostic.metadataHash) ? diagnostic.metadataHash : null;
  }
}
/** Only a local class instance in an Error cause chain has connector provenance; remote JSON does not. */
export function trustedMcpConnectorError(error:unknown):McpConnectorError|null {
  for(let depth=0;depth<4;depth++) {
    if(error instanceof McpConnectorError)return error;
    if(!(error instanceof Error))return null;
    error=Object.getOwnPropertyDescriptor(error,"cause")?.value;
  }
  return null;
}
