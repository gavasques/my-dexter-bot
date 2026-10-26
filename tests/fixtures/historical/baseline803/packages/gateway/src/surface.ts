import type { CapabilityScope, GatewayCallResult, ToolView } from "./gateway.js";

/** Trusted one-turn tool facade. Bearer tokens remain host-local; aliases bind targets in the MCP bridge. */
export interface TurnToolSurface {
  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope };
  listTools(token: string): ToolView[];
  call(token: string, input: unknown, options?: { signal?: AbortSignal }): Promise<GatewayCallResult>;
  revokeCapability(token: string): void;
}
