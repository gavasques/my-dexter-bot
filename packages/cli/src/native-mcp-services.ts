import { HostError } from "@dexter/hub";
import { mcpSetupDiagnostic,DiscoverMcpServerSchema } from "@dexter/contracts";
import type { HostMcpPort } from "@dexter/hub/http";
import {
  isNativeMcpCredentialRef, isNativeMcpHost, McpConnectorError, type McpCredentialStatus, type McpOAuthStart, type NativeMcpAdmin, type NativeMcpRuntime,
} from "@dexter/connectors";
import type { CredentialBroker, UpstreamAdapter } from "@dexter/gateway";

/**
 * Multiplexes the native MCP gateway ports next to the existing upstream (Composio managed apps or a trusted
 * injection). Routing is by the pinned manifest host / connection credential reference, both chosen by trusted host
 * code: `*.mcp.dexter.internal` and `mcp-none:*` go to native MCP, everything else is untouched.
 */
export function composeNativeMcpUpstream(native: Pick<NativeMcpRuntime, "adapter" | "broker">,
  base: { broker: CredentialBroker; adapter: UpstreamAdapter }): { broker: CredentialBroker; adapter: UpstreamAdapter } {
  const nativeAdapter = native.adapter, nativeBroker = native.broker, baseAdapter = base.adapter, baseBroker = base.broker;
  return Object.freeze({
    adapter: Object.freeze({
      execute: (call, auth, context) => isNativeMcpHost(call.host) ? nativeAdapter.execute(call, auth, context) : baseAdapter.execute(call, auth, context),
    } satisfies UpstreamAdapter),
    broker: Object.freeze({
      acquire: (ref, host) => isNativeMcpCredentialRef(ref) || isNativeMcpHost(host)
        ? (isNativeMcpCredentialRef(ref) && isNativeMcpHost(host) ? nativeBroker.acquire(ref, host) : null)
        : baseBroker.acquire(ref, host),
      secretValues: () => [...baseBroker.secretValues(), ...nativeBroker.secretValues()],
    } satisfies CredentialBroker),
  });
}

const INVALID = new Set(["invalid_request", "invalid_definition", "import_invalid", "import_unsupported", "secret_refused", "tool_not_allowed"]);
const MISSING = new Set(["server_unknown", "bot_unknown"]);
/** Credential/OAuth outcomes the owner UI acts on (unlock again, authorize again, configure custody). Fixed codes only. */
const CREDENTIAL = new Set(["custody_unavailable", "credential_locked", "credential_refused", "oauth_unavailable", "oauth_client_required",
  "oauth_metadata_invalid", "oauth_flow_failed", "oauth_denied", "oauth_state_mismatch", "oauth_expired", "needs_auth", "placement_unavailable"]);

/** Fixed code/message only: never upstream output, imported content, argument/env/header values or parser text. */
function hostError(error: unknown): unknown {
  if (error instanceof HostError) return error;
  if (error instanceof McpConnectorError) {
    const detail = error.detail === null ? "" : ` (${error.detail})`;
    if (INVALID.has(error.code)) return new HostError("invalid_input", `Native MCP request refused: ${error.code}${detail}.`);
    if (MISSING.has(error.code)) return new HostError("not_found", `Native MCP ${error.code === "bot_unknown" ? "bot" : "server"} not found.`);
    if (error.code === "closed" || error.code === "unbound") return new HostError("conflict", "Native MCP connections are not available.");
    if (CREDENTIAL.has(error.code)) return new HostError("conflict", `Native MCP credential unavailable: ${error.code}.`,
      mcpSetupDiagnostic("authentication",error.code) ?? undefined);
    return new HostError("conflict", `Native MCP request conflicts: ${error.code}.`);
  }
  return new HostError("conflict", "Native MCP operation failed.");
}
function guarded<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw hostError(error); }
}
async function guardedAsync<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) { throw hostError(error); }
}

/**
 * Local loopback HTTP port over the owner admin. `admin` is resolved per request through HostServices admission, so a
 * retained port refuses once shutdown begins. Optional HTTP-only discovery is fixed to the consented instance pin.
 */
export function nativeMcpHttpPort(admin: () => Readonly<NativeMcpAdmin>): Readonly<HostMcpPort> {
  return Object.freeze({
    credentials: nativeMcpCredentialPort(admin),
    listServers: () => guarded(() => admin().listServers()),
    previewImport: (input: unknown) => guarded(() => admin().previewImport(input)),
    addServer: (input: unknown) => guarded(() => admin().addServer(input)),
    discover: (id: string, input: unknown) => guardedAsync(async () => {
      const parsed=DiscoverMcpServerSchema.safeParse(input);
      if(!parsed.success)throw new McpConnectorError("invalid_request");
      return admin().discover(id,{
        ...(parsed.data.expectedInstancePin===undefined?{}:{expectedInstancePin:parsed.data.expectedInstancePin}),
        ...(parsed.data.httpOnly===true?{httpOnly:true as const}:{}),
      });
    }),
    tools: (id: string) => guarded(() => admin().tools(id)),
    botSelection: (id: string, botId: string) => guarded(() => admin().botSelection(id, botId)),
    setBotSelection: (id: string, botId: string, input: unknown) => guarded(() => admin().setBotSelection(id, botId, input)),
    removeServer: (id: string) => guardedAsync(() => admin().removeServer(id)),
  });
}

/**
 * Owner-local credential port (loopback router only, same guards as `/v1/mcp/*`). Root wiring, proposed routes:
 *   GET  /v1/mcp/servers/:id/credentials             -> credentialStatus
 *   POST /v1/mcp/servers/:id/credentials/unlock  {}  -> unlock
 *   POST /v1/mcp/servers/:id/credentials/lock    {}  -> lock
 *   POST /v1/mcp/servers/:id/credentials/disconnect {} -> disconnect
 *   POST /v1/mcp/servers/:id/oauth/start {clientId?, scope?, expectedInstancePin?} -> startOAuth
 * Bodies other than the documented ones are refused. Answers are value-free (`McpCredentialStatus`, `McpOAuthStart`).
 */
export interface NativeMcpCredentialPort {
  credentialStatus(id: string): { credentials: McpCredentialStatus };
  unlock(id: string, input: unknown): Promise<{ credentials: McpCredentialStatus }>;
  lock(id: string, input: unknown): Promise<{ credentials: McpCredentialStatus }>;
  disconnect(id: string, input: unknown): Promise<{ credentials: McpCredentialStatus }>;
  startOAuth(id: string, input: unknown): Promise<{ authorization: McpOAuthStart }>;
}
const emptyBody = (input: unknown): void => {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new McpConnectorError("invalid_request");
};
export function nativeMcpCredentialPort(admin: () => Readonly<NativeMcpAdmin>): Readonly<NativeMcpCredentialPort> {
  return Object.freeze({
    credentialStatus: (id: string) => guarded(() => ({ credentials: admin().credentialStatus(id) })),
    unlock: (id: string, input: unknown) => guardedAsync(async () => { emptyBody(input); return { credentials: await admin().unlockCredentials(id) }; }),
    lock: (id: string, input: unknown) => guardedAsync(async () => { emptyBody(input); return { credentials: await admin().lockCredentials(id) }; }),
    disconnect: (id: string, input: unknown) => guardedAsync(async () => { emptyBody(input); return { credentials: await admin().disconnectCredentials(id) }; }),
    startOAuth: (id: string, input: unknown) => guardedAsync(async () => ({ authorization: await admin().startOAuth(id, input) })),
  });
}
