import type { EngineCatalogEntry, EngineId, EngineSelection, ImageAttachment, JsonValue, ToolRequest } from "@dexter/contracts";

export interface EngineOpenOptions { selection?: EngineSelection }

export interface EngineStatus {
  engine: EngineId;
  installed: boolean;
  version: string | null;
  authentication: "unknown" | "required" | "authenticated";
  billing: "subscription";
}
export interface EngineCapabilities {
  resume: boolean;
  fork: boolean;
  interrupt: boolean;
  steer: boolean;
  supportsImages?:boolean;
}
/** Trusted host-only image seam. Metadata is durable; bytes/path are resolved after thread/turn identity checks. */
export interface EngineImageInput extends ImageAttachment { data?:Uint8Array; localPath?:string }
export interface EngineSession {
  threadId: string;
  /** Native cursor is local to the engine's host; never an OAuth credential. */
  nativeCursor: string;
}
export type EngineEvent =
  | { type: "text.delta"; threadId: string; turnId: string; text: string }
  | { type: "tool.request"; threadId: string; turnId: string; request: ToolRequest }
  | { type: "tool.result.observed"; threadId:string;turnId:string;actionId:string;requestHash:string;status:string }
  | { type: "turn.completed"; threadId: string; turnId: string; usage: JsonValue }
  | { type: "turn.interrupted"; threadId: string; turnId: string }
  | { type: "turn.failed"; threadId: string; turnId: string; code: string };

/** Native drivers expose only the operations implemented by this interface. */
export interface EngineDriver {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  status(): Promise<EngineStatus>;
  catalog?(): Promise<EngineCatalogEntry>;
  open(threadId: string, nativeCursor?: string, options?: EngineOpenOptions): Promise<EngineSession>;
  turn(session: EngineSession, turnId: string, input: string, signal: AbortSignal, selection?: EngineSelection, images?:readonly EngineImageInput[]): AsyncIterable<EngineEvent>;
  respondToTool(session: EngineSession, turnId: string, requestId: string, result: JsonValue): Promise<void>;
  interrupt(session: EngineSession, turnId: string): Promise<void>;
  close(session: EngineSession): Promise<void>;
}

export { ClaudeCliDriver } from './claude.js';
export type { ClaudeDriverOptions } from './claude.js';
export type { CodexDriverOptions } from './codex.js';
export { CodexAppServerDriver } from './codex.js';
export { EngineError } from './process.js';
export type { DriverOptions, EngineErrorCode } from './process.js';
export { GrokAcpDriver } from './grok.js';
export type { GrokDriverOptions } from './grok.js';
export { AntigravityAcpDriver } from './antigravity.js';
export type { AntigravityDriverOptions } from './antigravity.js';
export { MuseMspDriver } from './muse.js';
export type { MuseDriverOptions } from './muse.js';
export const DRIVER_IMPLEMENTATION_STATUS = { claude: "implemented_fixture_verified", codex: "implemented_fixture_verified",
  grok: "implemented", muse: "implemented", antigravity: "protocol_implemented_admission_blocked" } as const;

export type { NativeMcpServer } from './mcp-options.js';
export { isDexterGatewayToolName } from './mcp-options.js';
export { discoverNativeEngineFiles, discoverNativeEngines, discoverEngineCatalog } from './discovery.js';
export type { DiscoveredNativeEngine, EngineDiscoveryOptions } from './discovery.js';

export { CodexNativeVoiceBackend } from './codex-native-voice.js';
