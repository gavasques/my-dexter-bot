export type DeviceErrorCode =
  | "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable" | "timeout"
  | "tls_pin_mismatch" | "protocol_error" | "unsupported" | "outcome_unknown";

/**
 * Device errors carry a fixed code and a message built only from trusted constants. Never argument values,
 * file contents, certificate material, pairing codes or peer error text.
 */
export class DeviceError extends Error {
  constructor(readonly code: DeviceErrorCode, message: string = code) {
    super(message);
    this.name = "DeviceError";
  }
}
