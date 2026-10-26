import { checkEndpoint, checkMcpDefinition, MCP_ID, type McpServerDefinition } from "./definition.js";
import { McpConnectorError } from "./errors.js";
import { looksSecret } from "./import.js";

export interface McpHttpRegistration {
  schema_version: 1;
  /** Instance identity, independent of provider/endpoint. A new account gets a new ID; retries keep this ID. */
  server_id: string;
  name: string;
  url: string;
  /** broker explicitly means an owner-held Bearer token, not an inferred account or custody reference. */
  authentication: "none" | "broker" | "oauth";
}
const refuse = (code: "invalid_request" | "secret_refused" | "endpoint_invalid" | "endpoint_secret_refused"): never => { throw new McpConnectorError(code); };
/** Pure normalization only: no fetch, resolver, config read, credentials, registration or discovery. */
export function normalizeMcpHttpRegistration(raw: unknown): McpServerDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("invalid_request");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some(k => !["schema_version", "server_id", "name", "url", "authentication"].includes(k))
    || r.schema_version !== 1 || typeof r.name !== "string" || !r.name.trim() || r.name.length > 120
    || /[\u0000-\u001f\u007f]/.test(r.name) || typeof r.url !== "string" || r.url.length > 2048
    || !["none", "broker", "oauth"].includes(r.authentication as string)
    || typeof r.server_id !== "string" || !MCP_ID.test(r.server_id)) return refuse("invalid_request");
  const endpoint = r.url.trim();
  if (/[?#]/.test(endpoint)) return refuse("endpoint_secret_refused");
  if (/[\u0000-\u0020\u007f\\]/.test(endpoint)) return refuse("endpoint_invalid");
  let url: URL;
  try { url = new URL(endpoint); } catch { return refuse("endpoint_invalid"); }
  if (url.username || url.password || endpoint.slice(endpoint.indexOf(":") + 1).split("/").slice(0, 3).join("/").includes("@")) return refuse("endpoint_secret_refused");
  try { url = checkEndpoint(endpoint); } catch { return refuse("endpoint_invalid"); }
  if (looksSecret(r.name,undefined) || looksSecret(url.href,undefined)) return refuse("secret_refused");
  const id = r.server_id;
  return checkMcpDefinition({ id, name: r.name.trim(), auth: r.authentication, runsOn: "any",
    transport: { type: "streamable_http", url: url.href, headers: r.authentication === "broker"
      ? { authorization: { kind: "secret", key: "token", prefix: "Bearer " } } : {} },
    readOnlyTools: [], enabledTools: null, disabledTools: [], source: { format: "manual", name: id } });
}
