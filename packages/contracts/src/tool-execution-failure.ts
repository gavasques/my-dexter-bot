/** Closed, value-free failures raised by trusted adapters; remote JSON never gains this authority. */
export const TOOL_EXECUTION_FAILURE_CODES = [
  "metadata_quarantined", "schema_unsupported", "input_schema_invalid", "output_schema_invalid", "validation_resource_limit",
  "egress_refused", "protocol_unsupported", "header_mismatch", "input_required", "circuit_open",
  "command_changed", "credential_unavailable", "connection_changed", "transport_unavailable",
] as const;
export type ToolExecutionFailureCode = typeof TOOL_EXECUTION_FAILURE_CODES[number];
export type ToolExecutionPhase = "before_dispatch" | "after_dispatch";
/** Only adapter-owned evidence may mark before_dispatch. A transport timeout is after_dispatch. */
export class ToolExecutionFailure extends Error {
  readonly code: ToolExecutionFailureCode;
  readonly phase: ToolExecutionPhase;
  constructor(code: ToolExecutionFailureCode, phase: ToolExecutionPhase) {
    super(code);if(!TOOL_EXECUTION_FAILURE_CODES.includes(code)||!["before_dispatch","after_dispatch"].includes(phase))throw new TypeError("Invalid trusted execution failure.");
    this.name = "ToolExecutionFailure"; this.code = code; this.phase = phase;
  }
}
