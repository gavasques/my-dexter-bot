export type McpErrorCode =
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
  constructor(readonly code: McpErrorCode, readonly detail: string | null = null, readonly status: number | null = null) {
    super(`mcp: ${code}${detail === null ? "" : ` (${detail})`}${status === null ? "" : ` [${status}]`}`);
    this.name = "McpConnectorError";
  }
}
