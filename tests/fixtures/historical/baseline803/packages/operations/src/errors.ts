export type OperationsErrorCode =
  | "invalid_input"
  | "unsafe_path"
  | "destination_exists"
  | "fence_unavailable"
  | "unsupported_schema"
  | "unsupported_component"
  | "identity_mismatch"
  | "quota_exceeded"
  | "authentication_failed"
  | "corrupt"
  | "reference_broken"
  | "authority_unavailable"
  | "cleanup_incomplete";

/** Typed failure. Messages never include key material, row content or plaintext member bytes. */
export class OperationsError extends Error {
  override readonly name = "OperationsError";
  constructor(readonly code: OperationsErrorCode, message: string = code, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function fail(code: OperationsErrorCode, message?: string): never { throw new OperationsError(code, message); }
