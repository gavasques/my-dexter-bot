import { HostError } from "@dexter/hub";
import {
  ConnectionsError, ConnectionsRuntime, type ConnectionsAdmin, type ConnectionsRuntimeOptions, type DirectConnectionsSource, type NativeMcpAdmin,
} from "@dexter/connectors";

/**
 * Composition helpers for app connections (UX-P1-09). Owner-loopback HTTP port only: never a paired-client route, an
 * engine tool or MCP. Errors become fixed `HostError`s; provider uncertainty stays `outcome_unknown`.
 */
const CODES: Readonly<Record<ConnectionsError["code"], [HostError["code"], string]>> = Object.freeze({
  invalid_input: ["invalid_input", "Connection request refused."],
  forbidden: ["forbidden", "Connection operation is not allowed for this bot or profile."],
  not_found: ["not_found", "Connection item not found."],
  conflict: ["conflict", "Connection state changed. Refresh before trying again."],
  catalog_changed: ["conflict", "Connection catalog changed. Refresh it and confirm again."],
  unavailable: ["device_unavailable", "Connections service is unavailable."],
  outcome_unknown: ["outcome_unknown", "Connection outcome is unconfirmed."],
  closed: ["conflict", "Connections are not available."],
});
/** By class or by its fixed name/code (a second module instance of the same class must not degrade to `conflict`). */
function connectionsCode(error: unknown): ConnectionsError["code"] | null {
  if (error instanceof ConnectionsError) return error.code;
  const code = error instanceof Error && error.name === "ConnectionsError" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(CODES, code) ? code as ConnectionsError["code"] : null;
}
function hostError(error: unknown): unknown {
  if (error instanceof HostError) return error;
  const known = connectionsCode(error);
  if (known) { const [code, message] = CODES[known]; return new HostError(code, message); }
  if (error instanceof Error && error.name === "ZodError") return error;
  return new HostError("conflict", "Connection operation failed.");
}
const guarded = <T>(fn: () => T): T => { try { return fn(); } catch (error) { throw hostError(error); } };
const guardedAsync = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (error) { throw hostError(error); } };

/** `admin` is resolved per request through host admission, so a retained port refuses once shutdown begins. */
export function connectionsHttpPort(admin: () => Readonly<ConnectionsAdmin>) {
  return Object.freeze({
    status: () => guarded(() => admin().status()),
    catalog: () => guardedAsync(() => admin().catalog()),
    startAuthorization: (input: unknown) => guardedAsync(() => admin().startAuthorization(input)),
    authorization: (id: string) => guardedAsync(() => admin().authorization(id)),
    callback: (id: string, input: unknown) => guardedAsync(() => admin().callback(id, input)),
    accounts: () => guarded(() => admin().accounts()),
    account: (id: string) => guardedAsync(() => admin().account(id)),
    setAccess: (id: string, input: unknown) => guarded(() => admin().setAccess(id, input)),
    setLabel: (id: string, input: unknown) => guarded(() => admin().setLabel(id, input)),
    disconnect: (id: string, input: unknown) => guardedAsync(() => admin().disconnect(id, input)),
    receipt: (id: string) => guarded(() => admin().receipt(id)),
  });
}

/** Read-only projection of native MCP OAuth instances; credential state only, no custody read. */
export function nativeMcpDirectConnections(admin: () => Readonly<NativeMcpAdmin>, runtime: {
  durability(): "unconfigured" | "volatile" | "unverified" | "durable" | "unavailable"; persisted(id: string): boolean; connections(id: string): string[];
}): DirectConnectionsSource {
  return Object.freeze({
    // "persistent" only after the custodian confirmed durable custody; configuration alone never claims it.
    persistence: () => runtime.durability() === "durable" ? "persistent" as const : "volatile" as const,
    list: () => {
      const native = admin();
      return native.listServers().filter(server => server.auth === "oauth").map(server => {
        const status = native.credentialStatus(server.id), state = status.state;
        return { serverId: server.id, name: server.name, state: state === "unlocked" ? "connected" as const : state === "authorizing" ? "unknown" as const : "needs_reconnect" as const,
          persisted: state === "unlocked" && runtime.persisted(server.id), issuer: status.issuer, gatewayConnectionIds: runtime.connections(server.id) };
      });
    },
  });
}

/** Snapshot of the trusted provider object: methods captured once, no call, no I/O, no capability read. */
export function connectionsConfig(raw: Omit<ConnectionsRuntimeOptions, "identity">): Omit<ConnectionsRuntimeOptions, "identity"> {
  try {
    const config = { ...raw };
    if (Object.keys(config).some(key => !["platform", "credentialRef"].includes(key))) throw new Error();
    const platform = { ...config.platform };
    if (Object.keys(platform).some(key => !["origin", "capability", "fetch", "limits"].includes(key))) throw new Error();
    const capability = platform.capability, fetch = platform.fetch;
    if (typeof capability !== "function" || typeof fetch !== "function" || typeof platform.origin !== "string" || typeof config.credentialRef !== "string") throw new Error();
    const snapshot = Object.freeze({ credentialRef: config.credentialRef, platform: Object.freeze({ origin: platform.origin, capability: capability.bind(raw.platform),
      fetch: fetch.bind(raw.platform), ...(platform.limits === undefined ? {} : { limits: Object.freeze(JSON.parse(JSON.stringify(platform.limits)) as NonNullable<typeof platform.limits>) }) }) });
    // Pure validation instance: no database, request, timer or capability read.
    new ConnectionsRuntime({ ...snapshot, identity: { installationId: "validation", ownerId: "validation" } });
    return snapshot;
  } catch { throw new HostError("invalid_input", "Invalid connections configuration."); }
}
