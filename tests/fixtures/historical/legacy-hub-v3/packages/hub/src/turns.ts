import type { EngineId, JsonValue, ToolRequest } from "@dexter/contracts";

/**
 * Conversation turn types. They live in the hub until the root harmonizes them into @dexter/contracts.
 * A turn is one accepted user input and the engine run that answers it.
 */
export const TURN_STATES = ["queued", "running", "completed", "interrupted", "failed", "unknown"] as const;
export type TurnState = (typeof TURN_STATES)[number];
export const TERMINAL_TURN_STATES: ReadonlySet<TurnState> = new Set(["completed", "interrupted", "failed", "unknown"]);

export const TURN_EVENT_KINDS = [
  "turn.queued", "turn.started", "text.delta", "tool.requested", "tool.resolved",
  "turn.completed", "turn.interrupted", "turn.failed", "turn.unknown",
] as const;
export type TurnEventKind = (typeof TURN_EVENT_KINDS)[number];

/**
 * Normalized turn codes. Anything else reported by a driver becomes `engine_failed`; raw driver
 * messages and stderr are never stored.
 */
export const TURN_CODES = [
  // driver-reported (EngineErrorCode)
  "not_installed", "authentication_required", "subscription_required", "protocol_error", "process_exited", "timeout",
  "busy", "session_closed", "unsupported", "engine_failed", "usage_limit", "rate_limited", "engine_unavailable",
  "context_limit", "session_uncertain",
  // runtime-assigned
  "cancelled", "shutdown", "host_interrupted", "driver_unresponsive", "tool_identity_mismatch", "tool_limit",
  "tool_response_failed", "no_driver", "executor_unresponsive",
] as const;
export type TurnCode = (typeof TURN_CODES)[number];
const CODES: ReadonlySet<string> = new Set(TURN_CODES);
export function normalizeTurnCode(code: unknown): TurnCode {
  return typeof code === "string" && CODES.has(code) ? (code as TurnCode) : "engine_failed";
}

/** Assistant output kept per turn; matches the message content limit. Excess is dropped and flagged. */
export const MAX_TURN_OUTPUT_CHARS = 32_768;
/** Tool requests honoured per turn; the next one fails the turn with `tool_limit`. */
export const MAX_TOOL_REQUESTS_PER_TURN = 32;
/** Native cursors are opaque engine ids; anything else is never persisted or passed to `open`. */
export const NATIVE_CURSOR = /^[A-Za-z0-9_-]{1,128}$/;

export interface Turn {
  cursor: number;
  id: string;
  threadId: string;
  botId: string;
  engine: EngineId;
  clientRequestId: string;
  inputMessageId: string;
  outputMessageId: string | null;
  state: TurnState;
  code: TurnCode | null;
  outputChars: number;
  outputTruncated: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}
export interface TurnEvent {
  cursor: number;
  turnId: string;
  threadId: string;
  kind: TurnEventKind;
  /** Only `text.delta` carries text. */
  text: string | null;
  /** Ids, states and codes only; never tool arguments, results or engine output. */
  data: JsonValue | null;
  createdAt: number;
}
export interface ThreadSession {
  threadId: string;
  engine: EngineId;
  nativeCursor: string | null;
  updatedAt: number;
}
export interface StartTurnInput { clientRequestId: string; content: string }
export interface StartedTurn { turn: Turn; created: boolean }
export type TurnCounts = Record<TurnState, number>;

// ---- driver seam ------------------------------------------------------------------------------
// Structural mirror of the EngineDriver in @dexter/engines (the hub does not depend on engines).
// Any EngineDriver is assignable; tests inject fakes.

export interface RuntimeSession { threadId: string; nativeCursor: string }
export type RuntimeEngineEvent =
  | { type: "text.delta"; threadId: string; turnId: string; text: string }
  | { type: "tool.request"; threadId: string; turnId: string; request: ToolRequest }
  | { type: "turn.completed"; threadId: string; turnId: string; usage: JsonValue }
  | { type: "turn.interrupted"; threadId: string; turnId: string }
  | { type: "turn.failed"; threadId: string; turnId: string; code: string };
/**
 * How the runtime reuses a driver's sessions. `thread` (default): one session per thread, cached across
 * completed turns. `turn`: every turn opens a fresh session from the last confirmed cursor in the store and
 * the runtime closes it when the turn ends, whatever the outcome.
 */
export type RuntimeSessionReuse = "thread" | "turn";
/** Passed to `open` by `turn` drivers only: the claimed (running) turn and its abort signal. */
export interface RuntimeOpenContext { turnId: string; signal: AbortSignal }
export interface RuntimeDriver {
  readonly id: EngineId;
  readonly sessionReuse?: RuntimeSessionReuse;
  open(threadId: string, nativeCursor?: string, context?: RuntimeOpenContext): Promise<RuntimeSession>;
  turn(session: RuntimeSession, turnId: string, input: string, signal: AbortSignal): AsyncIterable<RuntimeEngineEvent>;
  respondToTool(session: RuntimeSession, turnId: string, requestId: string, result: JsonValue): Promise<void>;
  interrupt(session: RuntimeSession, turnId: string): Promise<void>;
  close(session: RuntimeSession): Promise<void>;
}
