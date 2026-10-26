export type ErrorCode = "not_found" | "conflict" | "forbidden" | "invalid_input" | "device_unavailable" | "outcome_unknown" | "host_locked";
export class HostError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "HostError";
  }
}

/** Error messages carry codes and issue paths only; never input values, which may hold user content. */
export function describeIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }>): string {
  return issues.slice(0, 5).map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`).join("; ");
}
