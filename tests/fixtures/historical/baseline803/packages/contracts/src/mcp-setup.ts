/** Closed, value-free setup diagnostics. Never accept upstream messages or URL/header/credential values. */
const RECOVERY = {
  invalid_definition: "correct_definition", invalid_request: "correct_input", secret_refused: "use_private_authentication",
  endpoint_invalid: "supply_known_http_mcp_endpoint", endpoint_secret_refused: "remove_url_credentials_query_fragment",
  server_unknown: "read_known_receipt", server_exists: "inspect_existing_registration", server_limit: "owner_manage_inventory",
  native_mcp_disabled: "owner_enable_native_mcp", placement_unavailable: "use_configured_host", unbound: "owner_enable_native_mcp",
  closed: "read_receipt_before_retry", store_conflict: "owner_recover_configuration", busy: "read_pending_action",
  configuration_changed: "read_and_propose_again", catalog_unavailable: "owner_approve_discovery", tool_not_allowed: "select_current_publishable_tools",
  tool_changed: "owner_review_catalog_again", scope_mismatch: "read_own_scope", bot_unknown: "read_own_scope", arguments_refused: "correct_input",
  needs_auth: "owner_authenticate_privately", credential_missing: "owner_authenticate_privately", credential_locked: "owner_unlock_privately",
  custody_unavailable: "owner_configure_private_custody", credential_refused: "owner_check_private_authentication",
  oauth_unavailable: "owner_configure_oauth", oauth_client_required: "owner_supply_registered_oauth_client",
  oauth_metadata_invalid: "owner_check_oauth_metadata", oauth_flow_failed: "owner_check_private_authentication",
  oauth_denied: "owner_authenticate_privately", oauth_state_mismatch: "owner_restart_private_authorization", oauth_expired: "owner_authenticate_privately",
  spawn_failed: "owner_check_program", connect_failed: "check_known_endpoint_then_propose_discovery", timeout: "read_receipt_before_retry",
  aborted: "read_receipt_before_retry", transport_failed: "check_known_endpoint_then_propose_discovery", upstream_redirect: "supply_known_http_mcp_endpoint",
  origin_refused: "supply_known_http_mcp_endpoint", upstream_status: "check_known_endpoint_then_propose_discovery", upstream_error: "read_receipt_before_retry",
  response_too_large: "owner_check_server_limits", response_invalid: "owner_check_mcp_protocol",
} as const;
export type McpSetupCause = keyof typeof RECOVERY;
export type McpSetupStage = "registration" | "configuration" | "host" | "discovery" | "authentication" | "selection";
export interface McpSetupDiagnostic { stage: McpSetupStage; code: McpSetupCause; recovery: typeof RECOVERY[McpSetupCause] }
const STAGES: readonly string[] = ["registration", "configuration", "host", "discovery", "authentication", "selection"];
export function mcpSetupDiagnostic(stage: McpSetupStage, code: string): McpSetupDiagnostic | null {
  if (!STAGES.includes(stage) || !Object.hasOwn(RECOVERY, code)) return null;
  const cause = code as McpSetupCause;
  return Object.freeze({ stage, code: cause, recovery: RECOVERY[cause] });
}
/** Validate persisted/transport projections rather than trusting a property named diagnostic. */
export function readMcpSetupDiagnostic(value: unknown): McpSetupDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "code,recovery,stage" || typeof v.code !== "string" || typeof v.stage !== "string") return null;
  const fixed = mcpSetupDiagnostic(v.stage as McpSetupStage, v.code);
  return fixed && v.recovery === fixed.recovery ? fixed : null;
}
