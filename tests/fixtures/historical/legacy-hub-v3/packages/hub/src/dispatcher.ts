import type { Action, JsonValue, ToolRequest } from "@dexter/contracts";
import type { HostStore } from "./store.js";

/**
 * Cancellation is advisory: an executor that supports it should stop as soon as `signal` aborts, but a
 * request already sent upstream may still take effect. Rejecting after an abort is an unknown outcome.
 */
export interface ToolExecutionContext { signal: AbortSignal }
export type ToolExecutor = (request: ToolRequest, context: ToolExecutionContext) => Promise<JsonValue>;

const NEVER_ABORTED = new AbortController().signal;

/**
 * Runs one ready action at most once. The claim (policy, grant revision and device revalidation plus
 * ready -> running) is a single synchronous transaction, so nothing can change between check and claim.
 * The executor only receives the stored request. A thrown executor error becomes `unknown` with a fixed
 * reason; its message is discarded because it may contain arbitrary or secret data. A crash while
 * running is recovered as `unknown` on the next open, never re-executed.
 */
export async function dispatchAction(store: HostStore, id: string, executor: ToolExecutor, signal: AbortSignal = NEVER_ABORTED): Promise<Action> {
  const action = store.claimAction(id);
  let result: JsonValue;
  try {
    result = await executor(structuredClone(action.request), { signal });
  } catch {
    return store.markUnknown(id, "executor_error");
  }
  try {
    return store.completeAction(id, result);
  } catch {
    // A receipt failure after dispatch must not leave a live host advertising an action as running.
    // If the lease is lost too, markUnknown fails closed and restart recovery resolves it instead.
    return store.markUnknown(id, "executor_error");
  }
}
