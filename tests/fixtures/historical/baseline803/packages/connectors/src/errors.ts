export type ConnectorErrorCode =
  // configuration and authority (refused before anything leaves the process)
  | "invalid_config" | "origin_refused" | "config_missing" | "scope_mismatch" | "tool_not_allowed"
  | "arguments_refused" | "auth_refused" | "request_too_large"
  // transport and upstream (the request may have reached upstream: the effect is ambiguous)
  | "timeout" | "aborted" | "transport_failed" | "upstream_redirect" | "upstream_status"
  | "response_too_large" | "response_invalid" | "upstream_error" | "session_policy_mismatch"
  // 1Password runner
  | "op_spawn_failed" | "op_failed" | "op_timeout" | "op_aborted" | "op_output_too_large" | "op_value_refused"
  | "credential_revoked";

/**
 * Connector errors carry a fixed code and a fixed message. Never upstream bodies, stderr, argument values,
 * secret references or credential material. `status` is the bare HTTP status when one was received.
 */
export class ConnectorError extends Error {
  constructor(readonly code: ConnectorErrorCode, readonly status: number | null = null) {
    super(status === null ? `connector: ${code}` : `connector: ${code} (${status})`);
    this.name = "ConnectorError";
  }
}
