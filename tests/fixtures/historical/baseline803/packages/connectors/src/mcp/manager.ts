import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mcpSetupDiagnostic, readMcpSetupDiagnostic, McpRegistrationRequestSchema, McpRegistrationReceiptQuerySchema, type McpRegistrationAuthority, type McpRegistrationReceipt, type McpRegistrationReceiptState, type McpRegistrationJournalStatus, McpInstanceSelectionInputSchema, McpInstanceSelectionPlanSchema, type McpInstanceSelectionPlan, type McpInstanceSelectionTarget, type McpInstanceSelectionJournal, type McpInstanceSelectionStep, type Action, type McpSetupDiagnostic, type JsonValue } from "@dexter/contracts";
import { manifestHash, type AdapterCall, type CapabilityGateway, type CredentialBroker, type InjectedAuth, type ToolManifest, type UpstreamAdapter } from "@dexter/gateway";
import { McpToolAdapter, probeMcpServer } from "./adapter.js";
import { McpToolCatalog, mcpToolName, type McpToolPlan } from "./catalog.js";
import { McpBrokerVault, secretSlotsOf, type McpSecretCustody } from "./credentials.js";
import { checkMcpDefinition, mcpConnectInput, mcpToolkit, MCP_ID, serverIdOfHost, type McpServerDefinition } from "./definition.js";
import { McpConnectorError, type McpErrorCode } from "./errors.js";
import { looksSecret, previewClaudeMcpJson, previewCodexToml, type McpImportPreview } from "./import.js";
import { MCP_OAUTH_ACCESS_KEY, McpOAuthClient, type McpOAuthOptions, type McpOAuthStart } from "./oauth.js";
import {
  NATIVE_MCP_RECEIPTS_SQL, NATIVE_MCP_RECEIPT_LIMIT, createMcpSetupReceipt, findMcpSetupReceipt,
  insertMcpSetupReceipt, mcpSetupHash, mcpSetupInstancePin, mcpSetupOriginHash, mcpSetupRequestHash,
  mcpSetupRequestKeyHash, validateMcpSetupReceipts, validateMcpSetupSchema,
} from "./setup-receipts.js";
import { NATIVE_MCP_INSTANCE_SCHEMA_VERSION, MCP_INSTANCE_SELECTION_SQL, MCP_INSTANCE_SELECTION_RECEIPT_LIMIT, MCP_INSTANCE_SELECTION_HEAD_LIMIT, validateMcpInstanceSelectionSchema, validateMcpInstanceSelectionRows, readMcpInstanceSelectionRow, putMcpInstanceSelectionJournal } from "./instance-selection-journal.js";
import { placementAllowed, type McpCredential, type McpDiscoveredTool, type McpRuntimeHost } from "./session.js";

/** Local owner API shapes (docs/execucao/integracoes/native-mcp-local-api-contract.md). Names are part of the contract. */
export interface McpServerSummary {
  id: string;
  name: string;
  transport: "stdio" | "streamable_http";
  runsOn: "owner_mac" | "cloud" | "any";
  auth: "none" | "broker" | "oauth";
  status: "configured" | "ready" | "needs_auth" | "unavailable_here" | "failed";
  /** URL without credentials/query, or the program. Never args, env or header values. */
  destination: string;
  /** Fixed stage/cause/recovery only; no upstream output or authentication material. */
  diagnostic?: McpSetupDiagnostic;
}
export interface McpToolSummary {
  id: string;
  name: string;
  description: string;
  effect: "read" | "write";
  state: "publishable" | "refused_by_policy" | "unsupported_schema";
}
export interface McpBotSelection { botId: string; toolIds: string[]; policy: "ask" }
/**
 * Value-free credential state of one server for the owner UI (docs/execucao/integracoes/native-mcp-auth-resume-2026-10-10.md).
 * `slots` are the definition's secret slot keys (names only). `issuer` is the validated OAuth issuer, shown before and
 * after approving. Never a value, a custody reference, a token or an authorization code.
 */
export interface McpCredentialStatus {
  serverId: string;
  auth: "none" | "broker" | "oauth";
  /** `1password`, `operator_sealed`... for broker; `oauth` for OAuth; null when none or not configured on this host. */
  custody: string | null;
  slots: string[];
  state: "not_required" | "unavailable" | "locked" | "unlocked" | "expired" | "unauthorized" | "authorizing";
  expiresAt: number | null;
  issuer: string | null;
  /** Fixed code of the last failed unlock/authorization/refresh. */
  lastError: string | null;
}

/**
 * Trusted host boundary (structurally the HostStore). Every write of this manager runs under the SAME canonical
 * writer lease; no store, writer or database of another installation is opened.
 */
export interface NativeMcpHost {
  readonly hostId: string;
  readonly ownerId: string;
  readonly databasePath: string;
  withWriterLease<T>(operation: () => T): T;
  getBot(id: string): { id: string; profileId: string; ownerId: string };
  getGrant(botId: string, tool: string, destination: string): { policy: "allow" | "ask" | "deny"; expiresAt: number | null; revision?: number } | null;
  setGrant(input: unknown): unknown;
  /** Optional canonical action seam; consolidated changes refuse without it, never synthesize approval. */
  assertActiveWriter?(): void;
  getAction?(id: string): Action;
  toolActionOrigin?(id: string): {turnId: string; callId: string; profileId: string} | null;
  ownerToolScope?(id: string): {installationId: string; ownerId: string; botId: string; profileId: string; threadId: string; turnId: string};
}

/** Owner-only administration. Never an engine tool and never on the paired-client router. */
export interface NativeMcpAdmin {
  listServers(): McpServerSummary[];
  /** Owner-only opaque pin of definition + full discovered schemas. Never exposes config or credential values. */
  configurationPin(id: string): string;
  /** Definition-only identity: catalog/auth status changes do not invalidate a registration receipt's scope. */
  definitionPin(id: string): string;
  /** Stored registration generation + definition. Removal/recreation cannot reuse an older receipt or proposal. */
  instancePin(id: string): string;
  previewImport(input: unknown): McpImportPreview;
  addServer(input: unknown): McpServerSummary;
  /** Atomic definition + generation + effect receipt. Host-derived authority only, never a model JSON field. */
  addServerWithReceipt(input: unknown, authority: McpRegistrationAuthority): McpRegistrationReceipt;
  /** Read-only original effect and current generation association, including after removal. */
  registrationReceipt(input: unknown, authority: McpRegistrationAuthority): McpRegistrationReceiptState | null;
  /** Read-only aggregate journal capacity; full refuses new registrations without discarding prior receipts. */
  registrationJournalStatus(authority: McpRegistrationAuthority): McpRegistrationJournalStatus;
  /** Model-approved discovery may use existing unlocked material only; owner UI keeps the explicit unlock default. */
  discover(id: string, options?: { unlockCredentials: false }): Promise<{ server: McpServerSummary; tools: McpToolSummary[] }>;
  tools(id: string): McpToolSummary[];
  botSelection(id: string, botId: string): McpBotSelection;
  setBotSelection(id: string, botId: string, input: unknown): McpBotSelection;
  /** Trusted host/capability-derived bot selector. No account subject or labels in the review. */
  instanceSelectionReview(botId: string): McpInstanceSelectionReview;
  materializeInstanceSelection(botId: string, input: unknown): McpInstanceSelectionPlan;
  /** Reads the approved canonical action and original plan itself; never accepts body authority. */
  applyInstanceSelection(actionId: string): McpInstanceSelectionOutcome;
  instanceSelectionReceipt(actionId: string): McpInstanceSelectionOutcome | null;
  removeServer(id: string): Promise<{ removed: true }>;
  /** Value-free credential state. Reads nothing from custody. */
  credentialStatus(id: string): McpCredentialStatus;
  /** Explicit owner action: broker reads every slot from custody; OAuth loads (and refreshes) tokens from the token store. */
  unlockCredentials(id: string): Promise<McpCredentialStatus>;
  /** Drops values/tokens from memory and ends the server's sessions. Custody keeps them. */
  lockCredentials(id: string): Promise<McpCredentialStatus>;
  /** Starts a local OAuth authorization; the owner opens `authorizationUrl` in their browser and approves there. */
  startOAuth(id: string, input: unknown): Promise<McpOAuthStart>;
  /** Locks and, for OAuth, removes the tokens from the token store (no remote revocation). */
  disconnectCredentials(id: string): Promise<McpCredentialStatus>;
}

export interface McpInstanceSelectionReview {
  botId: string; profileId: string; revision: number; inventoryPin: string; selectionPin: string;
  instances: Omit<McpInstanceSelectionTarget, "toolIds">[];
  selected: { serverId: string; connectionId: string; toolIds: string[] }[];
  unavailableInstances: {serverId: string; reason: "catalog_or_generation_unavailable"}[];
  authenticatedSubject: "unverified";
}
export interface McpInstanceSelectionOutcome {
  receipt: McpInstanceSelectionJournal;
  current: "matches" | "changed";
  matchingStepStates: number; totalSteps: number; replayed: boolean;
  grantsReplayed: false; authenticationVerified: false;
}

export interface NativeMcpRuntimeOptions {
  host: McpRuntimeHost;
  /** Inventory bound. Default 64. */
  maxServers?: number;
  /**
   * Trusted custody for `broker` servers (Mac: `onePasswordMcpCustody` over `OpCliSecretReader`). Absent: broker servers
   * stay `needs_auth` and never start. Values live in memory for `ttlMs` (default 1 h, max 12 h) after an explicit unlock.
   */
  credentials?: { custody: McpSecretCustody; ttlMs?: number };
  /**
   * Local OAuth for `oauth` servers. Default: enabled on `owner_mac` with in-memory tokens (lost on restart), disabled on
   * `cloud` (no owner browser there). `false` disables it. A trusted `store` (Keychain / operator-sealed file) keeps tokens.
   */
  oauth?: McpOAuthOptions | false;
}

export const NATIVE_MCP_DATABASE_FILE = "native-mcp.sqlite";
const SCHEMA = NATIVE_MCP_INSTANCE_SCHEMA_VERSION;
/** Gateway connection credential references, one per auth mode. The definition's auth mode never changes after storing. */
const CREDENTIAL_PREFIXES = Object.freeze({ none: "mcp-none:", broker: "mcp-broker:", oauth: "mcp-oauth:" } as const);
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_SELECTED = 256;
const MAX_IMPORT_CHARS = 1024 * 1024;
const MAX_DESCRIPTION = 1024;

type StoredStatus = "configured" | "ready" | "failed" | "needs_auth" | "deleting";
interface StoredTool {
  id: string;
  mcpName: string;
  description: string;
  effect: "read" | "write";
  state: McpToolSummary["state"];
  manifest: ToolManifest | null;
  argumentNames: Record<string, string> | null;
}
interface ServerState {
  definition: McpServerDefinition;
  status: StoredStatus;
  tools: StoredTool[] | null;
  catalog: McpToolCatalog | null;
  diagnostic?: McpSetupDiagnostic;
  generation?: string;
}
type Row = Record<string, unknown>;

const fail = (code: McpErrorCode, detail: string | null = null): never => { throw new McpConnectorError(code, detail); };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("invalid_request");
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some((k) => !keys.includes(k)) || keys.some((k) => !Object.hasOwn(value, k))) fail("invalid_request");
};
const serverId = (id: unknown): string => typeof id === "string" && MCP_ID.test(id) ? id : fail("server_unknown");
const credentialRef = (definition: McpServerDefinition): string => `${CREDENTIAL_PREFIXES[definition.auth]}${definition.id}`;
function parseCredentialRef(ref: string): { auth: McpServerDefinition["auth"]; id: string } | null {
  for (const auth of ["none", "broker", "oauth"] as const) {
    const prefix = CREDENTIAL_PREFIXES[auth];
    if (ref.startsWith(prefix)) return { auth, id: ref.slice(prefix.length) };
  }
  return null;
}
/** Upstream text shown to the owner: bounded, single line, no control characters. */
const display = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_DESCRIPTION);

function destination(definition: McpServerDefinition): string {
  // The definition validator already refuses userinfo, query and fragment in URLs.
  return definition.transport.type === "stdio" ? definition.transport.command : definition.transport.url;
}

/** Literal env/header values are never stored (imported values are always slots), nor credential-shaped args. */
function checkStorable(definition: McpServerDefinition): void {
  const t = definition.transport;
  const values = t.type === "stdio" ? t.env : t.headers;
  if (Object.values(values).some((v) => v.kind === "literal")) fail("secret_refused", "literal_values_not_stored");
  if (t.type === "stdio" && t.args.some((arg, i) => looksSecret(arg, t.args[i - 1]))) fail("secret_refused", "credential_like_argument");
}

function storedTools(definition: McpServerDefinition, plans: readonly McpToolPlan[], discovered: readonly McpDiscoveredTool[]): StoredTool[] {
  const descriptions = new Map(discovered.map((t) => [t.name, t.description]));
  const out: StoredTool[] = [];
  for (const plan of plans) {
    if (plan.status === "filtered") continue; // not offered by the owner's definition
    const id = plan.manifest?.name ?? mcpToolName(definition.id, plan.mcpName);
    out.push({
      id, mcpName: plan.mcpName, description: display(plan.manifest?.description ?? descriptions.get(plan.mcpName) ?? ""),
      effect: plan.manifest?.effect ?? (definition.readOnlyTools.includes(plan.mcpName) ? "read" : "write"),
      state: plan.status, manifest: plan.manifest, argumentNames: plan.argumentNames,
    });
  }
  return out;
}
const catalogOf = (id: string, tools: readonly StoredTool[]): McpToolCatalog => new McpToolCatalog(id, tools.map((t) => ({
  mcpName: t.mcpName, status: t.state, reason: null, manifest: t.manifest, argumentNames: t.argumentNames, upstreamHints: null,
})));

/**
 * Persistent owner-local runtime of native MCP connections, composed by HostServices next to the existing upstream
 * adapters (never replacing them). It owns:
 *   - a private database beside the canonical store (`native-mcp.sqlite`, created on the first stored server), written
 *     only under the canonical writer lease: definitions without secret values, the reviewed catalog, per-profile
 *     gateway connections and per-bot selections;
 *   - the gateway `adapter`/`broker` for `*.mcp.dexter.internal` logical hosts. The broker releases an EMPTY credential
 *     only for an `auth: none` server's own connection reference and logical host; nothing falls back to env or accounts;
 *   - explicit discovery (the only place a server is started by administration) and the selection -> manifest/grant flow.
 * Listing, reading or restoring never starts a server nor reads custody. `broker` servers run with values unlocked from
 * trusted custody by an explicit owner action; `oauth` servers with tokens from the owner's local authorization.
 */
export class NativeMcpRuntime {
  readonly adapter: UpstreamAdapter;
  readonly broker: CredentialBroker;
  readonly #host: McpRuntimeHost;
  readonly #maxServers: number;
  readonly #inner: McpToolAdapter;
  readonly #abort = new AbortController();
  readonly #servers = new Map<string, ServerState>();
  /** serverId -> profileId -> gateway connection id. */
  readonly #connections = new Map<string, Map<string, string>>();
  /** serverId -> botId -> selected manifest names. */
  readonly #selections = new Map<string, Map<string, string[]>>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #discovering = new Set<string>();
  readonly #adminPort: Readonly<NativeMcpAdmin>;
  readonly #vault: McpBrokerVault | null;
  readonly #oauth: McpOAuthClient | null;
  readonly #credentialErrors = new Map<string, string>();
  #store: NativeMcpHost | null = null;
  #gateway: CapabilityGateway | null = null;
  #db: DatabaseSync | null = null;
  #path: string | null = null;
  #refusing = false;
  #closed = false;
  #closeFlight: Promise<void> | null = null;

  constructor(options: NativeMcpRuntimeOptions) {
    const host = options?.host;
    if (host?.runsOn !== "owner_mac" && host?.runsOn !== "cloud") fail("invalid_definition", "host");
    if (typeof host.stdioRoot !== "string" || !host.stdioRoot.startsWith("/")) fail("invalid_definition", "host");
    const max = options.maxServers ?? 64;
    if (!Number.isSafeInteger(max) || max < 1 || max > 256) fail("invalid_definition", "maxServers");
    this.#host = Object.freeze({ ...host });
    this.#maxServers = max;
    this.#vault = options.credentials ? new McpBrokerVault({ custody: options.credentials.custody, ...(options.credentials.ttlMs === undefined ? {} : { ttlMs: options.credentials.ttlMs }) }) : null;
    const oauth = options.oauth ?? (host.runsOn === "owner_mac" ? {} : false);
    this.#oauth = oauth === false ? null : new McpOAuthClient({ ...(host.fetch ? { fetch: host.fetch } : {}), ...oauth });
    this.#inner = new McpToolAdapter({
      servers: { get: (id) => { const s = this.#active(id); return s && this.#authSupported(s.definition) ? s.definition : null; } },
      catalog: { find: (id, slug) => this.#active(id)?.catalog?.find(id, slug) ?? null },
      host: this.#host,
    });
    this.adapter = Object.freeze({ execute: (call: AdapterCall, auth: InjectedAuth, context: { signal: AbortSignal }) => this.#execute(call, auth, context) });
    this.broker = Object.freeze({
      acquire: (ref: string, host: string) => this.#credential(ref, host),
      secretValues: () => [...(this.#vault?.secretValues() ?? []), ...(this.#oauth?.secretValues() ?? [])],
    });
    this.#adminPort = Object.freeze({
      listServers: () => { this.#admitted(); return [...this.#servers.keys()].sort().flatMap((id) => { const s = this.#active(id); return s ? [this.#summary(s)] : []; }); },
      configurationPin: (id: string) => {
        this.#admitted();
        const state = this.#require(id);
        const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
          : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)])) : value;
        return createHash("sha256").update(JSON.stringify(canonical({ definition: state.definition, generation: state.generation ?? null, tools: state.tools, status: state.status }))).digest("hex");
      },
      definitionPin: (id: string) => {
        this.#admitted();
        const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
          : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => [key,canonical(item)])) : value;
        return createHash("sha256").update(JSON.stringify(canonical(this.#require(id).definition))).digest("hex");
      },
      instancePin: (id: string) => {
        this.#admitted(); const state = this.#require(id);
        return createHash("sha256").update(JSON.stringify({ definitionHash: this.#adminPort.definitionPin(id), generation: state.generation ?? null })).digest("hex");
      },
      previewImport: (input: unknown) => { this.#admitted(); return this.#preview(input); },
      addServer: (input: unknown) => this.#add(input),
      addServerWithReceipt: (input: unknown, authority: McpRegistrationAuthority) => this.#addWithReceipt(input, authority),
      registrationReceipt: (input: unknown, authority: McpRegistrationAuthority) => this.#registrationReceipt(input, authority),
      registrationJournalStatus: (authority: McpRegistrationAuthority) => this.#registrationJournalStatus(authority),
      discover: (id: string, options?: { unlockCredentials: false }) => this.#track(() => this.#discover(id, options?.unlockCredentials !== false)),
      tools: (id: string) => { this.#admitted(); return this.#visible(this.#require(id).tools ?? []); },
      botSelection: (id: string, botId: string) => this.#selection(id, botId),
      setBotSelection: (id: string, botId: string, input: unknown) => this.#select(id, botId, input),
      instanceSelectionReview: (botId: string) => this.#instanceReview(botId),
      materializeInstanceSelection: (botId: string, input: unknown) => this.#instancePlan(botId, input),
      applyInstanceSelection: (actionId: string) => this.#applyInstances(actionId),
      instanceSelectionReceipt: (actionId: string) => this.#instanceReceipt(actionId),
      removeServer: (id: string) => this.#track(() => this.#remove(id)),
      credentialStatus: (id: string) => { this.#admitted(); return this.#credentialStatus(this.#require(id)); },
      unlockCredentials: (id: string) => this.#track(() => this.#unlock(id)),
      lockCredentials: (id: string) => this.#track(() => this.#lock(id, false)),
      startOAuth: (id: string, input: unknown) => this.#track(() => this.#startOAuth(id, input)),
      disconnectCredentials: (id: string) => this.#track(() => this.#lock(id, true)),
    });
  }

  /** Resolve per admin operation; refuses once shutdown began. */
  get admin(): Readonly<NativeMcpAdmin> { this.#admitted(); return this.#adminPort; }
  get openSessions(): number { return this.#inner.openSessions; }

  /**
   * Binds to the canonical store and its gateway (same installation, owner and data directory). Reads persisted rows
   * only: finishes interrupted removals, re-registers the reviewed manifests of selected tools with their pins, retires
   * unselected ones and turns stray grants of unselected tools into deny. Never starts a server and never creates an
   * ask grant (grants revoked or expired at the hub stay so).
   */
  bind(store: NativeMcpHost, gateway: CapabilityGateway): void {
    if (this.#refusing || this.#closed) fail("closed");
    if (this.#store) fail("store_conflict");
    if (gateway.registry.installationId !== store.hostId || gateway.registry.ownerId !== store.ownerId
      || dirname(gateway.registry.databasePath) !== dirname(store.databasePath)) fail("store_conflict");
    this.#path = join(dirname(store.databasePath), NATIVE_MCP_DATABASE_FILE);
    this.#store = store;
    this.#gateway = gateway;
    try {
      if (existsSync(this.#path) || existsSync(`${this.#path}-wal`)) {
        this.#db = this.#openDatabase(false);
        this.#load();
        for (const [id, state] of [...this.#servers]) if (state.status === "deleting") this.#finishRemoval(id);
        for (const id of this.#servers.keys()) this.#reconcile(id);
      }
      gateway.setNativeMcpApprovalEligibility((scope, tool, connection) => {
        const id = serverIdOfHost(tool.manifest.upstreamHost), state = id === null ? null : this.#active(id);
        if (!state || id === null || state.status !== "ready" || !this.#authSupported(state.definition) || !placementAllowed(state.definition, this.#host)
          || scope.installationId !== store.hostId || scope.ownerId !== store.ownerId || connection.profileId !== scope.profileId
          || this.#connections.get(id)?.get(scope.profileId) !== connection.id || tool.manifest.toolkit !== mcpToolkit(id)
          || !this.#selections.get(id)?.get(scope.botId)?.includes(tool.manifest.name)) return false;
        const reviewed = state.tools?.find(item => item.id === tool.manifest.name && item.state === "publishable")?.manifest;
        return Boolean(reviewed && manifestHash(reviewed) === tool.manifestHash);
      });
    } catch (error) {
      this.disposeUnbound();
      throw error;
    }
  }

  /** Synchronous rollback for a failed host construction: closes the database, starts nothing. */
  disposeUnbound(): void {
    this.#refusing = true;
    this.#closed = true;
    this.#vault?.clear();
    void this.#oauth?.close();
    const db = this.#db;
    this.#db = null;
    if (db) { try { this.#store?.withWriterLease(() => db.close()); } catch { db.close(); } }
  }

  /** Stops admitting administration and calls; in-flight work continues until close(). */
  stopAdmission(): void { this.#refusing = true; }

  /** Aborts discovery/calls, ends every session and process group, then closes the database under the writer. */
  close(): Promise<void> {
    this.#refusing = true;
    return this.#closeFlight ??= (async () => {
      this.#abort.abort();
      this.#vault?.clear();
      await Promise.allSettled([...this.#work]);
      await this.#oauth?.close();
      await this.#inner.close();
      const db = this.#db;
      this.#db = null;
      if (db) this.#store!.withWriterLease(() => db.close());
      this.#closed = true;
    })();
  }

  // ---- admission and state ---------------------------------------------------------------------

  #admitted(): { store: NativeMcpHost; gateway: CapabilityGateway } {
    if (this.#refusing || this.#closed) return fail("closed");
    if (!this.#store || !this.#gateway) return fail("unbound");
    return { store: this.#store, gateway: this.#gateway };
  }
  /** Writer fence before any effect: a refused writer produces nothing. */
  #fenced(): { store: NativeMcpHost; gateway: CapabilityGateway } {
    const port = this.#admitted();
    port.store.withWriterLease(() => undefined);
    return port;
  }
  #active(id: string): ServerState | null {
    const s = this.#servers.get(id);
    return s && s.status !== "deleting" && !this.#refusing && !this.#closed ? s : null;
  }
  #require(id: unknown): ServerState {
    return this.#active(serverId(id)) ?? fail("server_unknown");
  }
  #track<T>(fn: () => Promise<T>): Promise<T> {
    let run: Promise<T>;
    try { this.#admitted(); run = fn(); } catch (error) { return Promise.reject(error); }
    this.#work.add(run);
    void run.then(() => this.#work.delete(run), () => this.#work.delete(run));
    return run;
  }
  #summary(s: ServerState): McpServerSummary {
    const d = s.definition;
    const status: McpServerSummary["status"] = !placementAllowed(d, this.#host) ? "unavailable_here"
      : !this.#authSupported(d) || this.#credentialOf(d) === null ? "needs_auth"
        : s.status === "deleting" ? "failed" : s.status;
    const diagnostic = status === "unavailable_here" ? mcpSetupDiagnostic("host", "placement_unavailable")
      : status === "needs_auth" ? mcpSetupDiagnostic("authentication", !this.#authSupported(d)
        ? d.auth === "broker" ? "custody_unavailable" : "oauth_unavailable"
        : s.diagnostic?.stage === "authentication" ? s.diagnostic.code : d.auth === "broker" ? "credential_locked" : "needs_auth")
        : s.diagnostic ?? null;
    return { id: d.id, name: d.name, transport: d.transport.type, runsOn: d.runsOn, auth: d.auth, status, destination: destination(d),
      ...(diagnostic ? { diagnostic } : {}) };
  }
  #visible(tools: readonly StoredTool[]): McpToolSummary[] {
    return tools.map((t) => ({ id: t.id, name: t.mcpName, description: t.description, effect: t.effect, state: t.state }));
  }

  // ---- persistence -----------------------------------------------------------------------------

  #files(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      let stat;
      try { stat = lstatSync(this.#path! + suffix); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) fail("store_conflict");
      chmodSync(this.#path! + suffix, 0o600);
    }
  }
  #openDatabase(create: boolean): DatabaseSync {
    const store = this.#store!;
    return store.withWriterLease(() => {
      this.#files();
      if (!create && !existsSync(this.#path!)) fail("store_conflict");
      const db = new DatabaseSync(this.#path!, { timeout: 5_000 });
      try {
        chmodSync(this.#path!, 0o600);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
        const empty = Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as Row).n) === 0;
        if (empty) db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY, definition TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('configured','ready','failed','needs_auth','deleting'))) STRICT;
          CREATE TABLE IF NOT EXISTS catalogs(server_id TEXT PRIMARY KEY, tools TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS connections(server_id TEXT NOT NULL, profile_id TEXT NOT NULL, connection_id TEXT NOT NULL,
            PRIMARY KEY(server_id, profile_id)) STRICT;
          CREATE TABLE IF NOT EXISTS selections(server_id TEXT NOT NULL, bot_id TEXT NOT NULL, tools TEXT NOT NULL,
            PRIMARY KEY(server_id, bot_id)) STRICT;`);
        const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row | undefined)?.value;
        if (empty) {
          const put = db.prepare("INSERT INTO meta VALUES (?,?)");
          for (const [k, v] of [["schema", SCHEMA], ["installation", store.hostId], ["owner", store.ownerId]]) put.run(k!, v!);
        }
        if (get("installation") !== store.hostId || get("owner") !== store.ownerId) fail("store_conflict");
        if (empty) {
          db.exec(NATIVE_MCP_RECEIPTS_SQL + MCP_INSTANCE_SELECTION_SQL);
        } else if (get("schema") === "1") {
          validateMcpSetupSchema(db, "1");
          db.exec(NATIVE_MCP_RECEIPTS_SQL + MCP_INSTANCE_SELECTION_SQL);
          db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(SCHEMA);
        } else if (get("schema") === "2") {
          validateMcpSetupSchema(db, "2"); validateMcpSetupReceipts(db);
          db.exec(MCP_INSTANCE_SELECTION_SQL);
          db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(SCHEMA);
        } else if (get("schema") !== SCHEMA) fail("store_conflict");
        validateMcpInstanceSelectionSchema(db); validateMcpInstanceSelectionRows(db);
        validateMcpSetupReceipts(db);
        db.exec("COMMIT");
        this.#files();
        return db;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
        db.close();
        throw error;
      }
    });
  }
  /** One transaction of this database under the canonical writer. Memory is updated by callers only after commit. */
  #write<T>(fn: (db: DatabaseSync) => T): T {
    const store = this.#store ?? fail("unbound");
    if (this.#closed) fail("closed");
    // Created on the first stored record, in its own writer section (the lease is not reentrant).
    if (!this.#db) this.#db = this.#openDatabase(true);
    const db = this.#db;
    return store.withWriterLease(() => {
      this.#files();
      db.exec("BEGIN IMMEDIATE");
      try {
        this.#checkReceiptStore(db);
        const result = fn(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  #checkReceiptStore(db: DatabaseSync): void {
    validateMcpInstanceSelectionSchema(db); validateMcpInstanceSelectionRows(db);
    const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row | undefined)?.value;
    if (get("schema") !== SCHEMA || get("installation") !== this.#store!.hostId || get("owner") !== this.#store!.ownerId) fail("store_conflict");
    validateMcpSetupReceipts(db);
  }
  #load(): void {
    const db = this.#db!;
    try {
      for (const row of db.prepare("SELECT id, definition, status FROM servers ORDER BY id").all() as Row[]) {
        const definition = checkMcpDefinition(JSON.parse(row.definition as string));
        if (definition.id !== row.id) fail("store_conflict");
        const catalog = db.prepare("SELECT tools FROM catalogs WHERE server_id=?").get(definition.id) as Row | undefined;
        const tools = catalog ? this.#readTools(definition, JSON.parse(catalog.tools as string)) : null;
        const metadata = db.prepare("SELECT value FROM meta WHERE key=?").get(`mcp-diagnostic:${definition.id}`) as Row | undefined;
        let diagnostic: McpSetupDiagnostic | null = null;
        const instance = db.prepare("SELECT value FROM meta WHERE key=?").get(`mcp-instance:${definition.id}`) as Row | undefined;
        if (instance && (typeof instance.value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(instance.value))) fail("store_conflict");
        if (metadata) {
          if (typeof metadata.value !== "string" || metadata.value.length > 1024) fail("store_conflict");
          diagnostic = readMcpSetupDiagnostic(JSON.parse(metadata.value as string));
          if (!diagnostic || JSON.stringify(diagnostic) !== metadata.value || !["failed","needs_auth"].includes(row.status as string)) fail("store_conflict");
        }
        this.#servers.set(definition.id, { definition, status: row.status as StoredStatus, tools, catalog: tools ? catalogOf(definition.id, tools) : null,
          ...(diagnostic ? { diagnostic } : {}), ...(instance ? { generation: instance.value as string } : {}) });
      }
      for (const row of db.prepare("SELECT server_id, profile_id, connection_id FROM connections").all() as Row[]) {
        if (!this.#servers.has(row.server_id as string)) continue;
        this.#mapOf(this.#connections, row.server_id as string).set(row.profile_id as string, row.connection_id as string);
      }
      for (const row of db.prepare("SELECT server_id, bot_id, tools FROM selections").all() as Row[]) {
        if (!this.#servers.has(row.server_id as string)) continue;
        const tools = JSON.parse(row.tools as string) as unknown;
        if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) fail("store_conflict");
        this.#mapOf(this.#selections, row.server_id as string).set(row.bot_id as string, tools as string[]);
      }
    } catch (error) {
      if (error instanceof McpConnectorError && error.code === "store_conflict") throw error;
      throw new McpConnectorError("store_conflict");
    }
  }
  /** Persisted catalog rows are re-validated: manifests must belong to this server's toolkit and logical host. */
  #readTools(definition: McpServerDefinition, raw: unknown): StoredTool[] {
    if (!Array.isArray(raw)) return fail("store_conflict");
    const tools = raw.map((value): StoredTool => {
      const t = object(value);
      if (typeof t.id !== "string" || typeof t.mcpName !== "string" || typeof t.description !== "string"
        || (t.effect !== "read" && t.effect !== "write") || !["publishable", "refused_by_policy", "unsupported_schema"].includes(t.state as string)) fail("store_conflict");
      return { id: t.id as string, mcpName: t.mcpName as string, description: t.description as string, effect: t.effect as StoredTool["effect"],
        state: t.state as StoredTool["state"], manifest: (t.manifest ?? null) as ToolManifest | null, argumentNames: (t.argumentNames ?? null) as Record<string, string> | null };
    });
    catalogOf(definition.id, tools); // throws on a foreign toolkit/host or duplicate slug
    return tools;
  }
  #mapOf<V>(map: Map<string, Map<string, V>>, id: string): Map<string, V> {
    let inner = map.get(id);
    if (!inner) { inner = new Map(); map.set(id, inner); }
    return inner;
  }

  // ---- administration --------------------------------------------------------------------------

  #preview(input: unknown): McpImportPreview {
    const body = object(input);
    exactKeys(body, ["format", "content"]);
    if (typeof body.content !== "string" || body.content.length > MAX_IMPORT_CHARS) fail("invalid_request");
    // Content handed in explicitly; nothing is read from disk, executed, expanded or stored.
    if (body.format === "claude_json") return previewClaudeMcpJson(body.content as string);
    if (body.format === "codex_toml") return previewCodexToml(body.content as string);
    return fail("invalid_request");
  }

  #add(input: unknown): McpServerSummary {
    this.#admitted();
    const body = object(input);
    exactKeys(body, ["definition"]);
    const definition = checkMcpDefinition(body.definition);
    checkStorable(definition);
    if (this.#servers.has(definition.id)) fail("server_exists");
    if (this.#servers.size >= this.#maxServers) fail("server_limit");
    this.#fenced();
    const generation = randomUUID();
    this.#write((db) => {
      if (db.prepare("SELECT 1 AS x FROM servers WHERE id=?").get(definition.id)) fail("server_exists");
      db.prepare("INSERT INTO servers (id, definition, status) VALUES (?, ?, 'configured')").run(definition.id, JSON.stringify(definition));
      db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(`mcp-instance:${definition.id}`, generation);
    });
    const state: ServerState = { definition, status: "configured", tools: null, catalog: null, generation };
    this.#servers.set(definition.id, state);
    return this.#summary(state);
  }

  #addWithReceipt(input: unknown, authority: McpRegistrationAuthority): McpRegistrationReceipt {
    const { store } = this.#admitted();
    const originHash = mcpSetupOriginHash(authority, store);
    const parsed = McpRegistrationRequestSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_request");
    const rawDefinition = object(parsed.data.definition);
    // Informational import provenance may only be assigned by the separate owner import flow.
    // This new operation cannot accept model-asserted source/authority, even nested in a definition.
    if (Object.hasOwn(rawDefinition, "source")) fail("invalid_request");
    const definition = checkMcpDefinition(rawDefinition);
    checkStorable(definition);
    const definitionPin = mcpSetupHash(definition);
    const inputHash = mcpSetupHash(rawDefinition);
    const requestHash = mcpSetupRequestHash(definitionPin, inputHash);
    const requestKeyHash = mcpSetupRequestKeyHash(originHash, parsed.data.requestId);
    this.#fenced();
    const receipt = this.#write(db => {
      const previous = findMcpSetupReceipt(db, requestKeyHash, originHash);
      if (previous) {
        if (previous.requestHash !== requestHash) fail("invalid_request", "setup_request_changed");
        return previous;
      }
      if (db.prepare("SELECT 1 AS x FROM servers WHERE id=?").get(definition.id)) fail("server_exists");
      const count = db.prepare("SELECT COUNT(*) AS n FROM servers").get() as Row;
      if (Number(count.n) >= this.#maxServers) fail("server_limit");
      const generation = randomUUID();
      const created = createMcpSetupReceipt({ requestKeyHash, requestIdHash: mcpSetupHash({ requestId: parsed.data.requestId }), requestHash, inputHash, originHash, instanceId: definition.id, generation, definitionPin });
      db.prepare("INSERT INTO servers (id,definition,status) VALUES (?,?,'configured')").run(definition.id, JSON.stringify(definition));
      db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(`mcp-instance:${definition.id}`, generation);
      insertMcpSetupReceipt(db, created);
      return created;
    });
    // Replay after removal must not resurrect a registration; only mirror the committed original generation.
    const live = this.#db!.prepare("SELECT definition,status FROM servers WHERE id=?").get(receipt.instanceId) as Row | undefined;
    const instance = this.#db!.prepare("SELECT value FROM meta WHERE key=?").get(`mcp-instance:${receipt.instanceId}`) as Row | undefined;
    if (live && instance?.value === receipt.generation && !this.#servers.has(receipt.instanceId)) {
      this.#servers.set(receipt.instanceId, { definition: checkMcpDefinition(JSON.parse(live.definition as string)), status: live.status as StoredStatus,
        tools: null, catalog: null, generation: receipt.generation });
    }
    return receipt;
  }

  #registrationReceipt(input: unknown, authority: McpRegistrationAuthority): McpRegistrationReceiptState | null {
    const { store } = this.#admitted();
    const originHash = mcpSetupOriginHash(authority, store);
    const parsed = McpRegistrationReceiptQuerySchema.safeParse(input);
    if (!parsed.success) return fail("invalid_request");
    const db = this.#db;
    if (!db) return null; // Never create/open storage in a read-only receipt operation.
    this.#checkReceiptStore(db);
    const receipt = findMcpSetupReceipt(db, mcpSetupRequestKeyHash(originHash, parsed.data.requestId), originHash);
    if (!receipt) return null;
    const live = db.prepare("SELECT definition,status FROM servers WHERE id=?").get(receipt.instanceId) as Row | undefined;
    if (!live || live.status === "deleting") return { receipt, instanceState: "removed" };
    const instance = db.prepare("SELECT value FROM meta WHERE key=?").get(`mcp-instance:${receipt.instanceId}`) as Row | undefined;
    if (instance && (typeof instance.value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(instance.value))) fail("store_conflict");
    if (instance?.value !== receipt.generation) return { receipt, instanceState: "replaced" };
    const definition = checkMcpDefinition(JSON.parse(live.definition as string));
    if (definition.id !== receipt.instanceId || mcpSetupHash(definition) !== receipt.definitionPin
      || mcpSetupInstancePin(receipt.definitionPin, receipt.generation) !== receipt.instancePin) fail("store_conflict");
    return { receipt, instanceState: "registered" };
  }

  #registrationJournalStatus(authority: McpRegistrationAuthority): McpRegistrationJournalStatus {
    const { store } = this.#admitted();
    mcpSetupOriginHash(authority, store);
    const db = this.#db;
    if (db) this.#checkReceiptStore(db);
    const used = db ? Number((db.prepare("SELECT COUNT(*) AS n FROM setup_receipts").get() as Row).n) : 0;
    return { version: 1, used, limit: NATIVE_MCP_RECEIPT_LIMIT, remaining: NATIVE_MCP_RECEIPT_LIMIT - used,
      registrationCapacity: used < NATIVE_MCP_RECEIPT_LIMIT ? "available" : "full" };
  }

  async #discover(id: string, unlockCredentials = true): Promise<{ server: McpServerSummary; tools: McpToolSummary[] }> {
    const state = this.#require(id);
    const definition = state.definition;
    // Refused before anything starts: servers pinned elsewhere, and auth modes without custody on this host.
    if (!this.#authSupported(definition) || !placementAllowed(definition, this.#host)) return { server: this.#summary(state), tools: [] };
    if (this.#discovering.has(definition.id)) fail("busy");
    this.#fenced();
    this.#discovering.add(definition.id);
    try {
      // Discovery is an explicit owner action: a locked broker server is unlocked from custody, OAuth tokens are
      // restored from the token store. Still no credential: needs_auth, nothing started, nothing persisted.
      let credential = this.#credentialOf(definition);
      if (credential === null) {
        if (!unlockCredentials) return { server: this.#summary(state), tools: [] };
        try { await this.#unlockOf(definition); } catch { /* recorded as lastError; reported as needs_auth */ }
        credential = this.#credentialOf(definition);
      }
      if (this.#active(definition.id) !== state) fail("server_unknown");
      this.#admitted();
      if (credential === null) return { server: this.#summary(state), tools: [] };
      const probe = await probeMcpServer(definition, credential, this.#host, this.#abort.signal);
      // A shutdown or removal meanwhile: nothing from this probe is persisted or applied.
      const current = this.#active(definition.id);
      this.#admitted();
      if (current !== state) fail("server_unknown");
      if (probe.state !== "ready") {
        const status: StoredStatus = probe.state === "needs_auth" ? "needs_auth" : "failed";
        const diagnostic = mcpSetupDiagnostic(probe.state === "needs_auth" ? "authentication" : probe.state === "unavailable_here" ? "host" : "discovery",
          probe.state === "needs_auth" ? "needs_auth" : probe.state === "unavailable_here" ? "placement_unavailable" : probe.code);
        this.#write((db) => {
          db.prepare("UPDATE servers SET status=? WHERE id=? AND status<>'deleting'").run(status, definition.id);
          if (diagnostic) db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(`mcp-diagnostic:${definition.id}`, JSON.stringify(diagnostic));
        });
        state.status = status;
        if (diagnostic) state.diagnostic = diagnostic;
        return { server: this.#summary(state), tools: [] };
      }
      return this.#acceptCatalog(state, storedTools(definition, probe.tools, probe.discovered));
    } finally {
      this.#discovering.delete(definition.id);
    }
  }

  /**
   * Replaces the reviewed catalog. A selected tool whose pinned definition changed upstream, vanished or is no longer
   * publishable is dropped from every selection (its grants become deny and its manifest is retired): the owner must
   * select it again; nothing is re-approved silently.
   */
  #acceptCatalog(state: ServerState, planned: StoredTool[]): { server: McpServerSummary; tools: McpToolSummary[] } {
    const id = state.definition.id;
    const fresh = new Map(planned.filter((t) => t.state === "publishable" && t.manifest).map((t) => [t.id, t]));
    const old = new Map((state.tools ?? []).map((t) => [t.id, t]));
    const unchanged = (name: string): boolean => {
      const a = old.get(name)?.manifest, b = fresh.get(name)?.manifest;
      return Boolean(a && b && manifestHash(a) === manifestHash(b));
    };
    const selections = this.#selections.get(id) ?? new Map<string, string[]>();
    const next = new Map([...selections].map(([bot, names]) => [bot, names.filter(unchanged)]));
    const dropped = [...selections].flatMap(([bot, names]) => names.filter((n) => !unchanged(n)).map((n) => [bot, n] as const));
    const catalog = catalogOf(id, planned);
    this.#write((db) => {
      db.prepare("INSERT INTO catalogs (server_id, tools) VALUES (?, ?) ON CONFLICT (server_id) DO UPDATE SET tools=excluded.tools").run(id, JSON.stringify(planned));
      db.prepare("UPDATE servers SET status='ready' WHERE id=?").run(id);
      db.prepare("DELETE FROM meta WHERE key=?").run(`mcp-diagnostic:${id}`);
      for (const [bot, names] of next) db.prepare("UPDATE selections SET tools=? WHERE server_id=? AND bot_id=?").run(JSON.stringify(names), id, bot);
    });
    state.tools = planned;
    state.catalog = catalog;
    state.status = "ready";
    delete state.diagnostic;
    for (const [bot, names] of next) this.#mapOf(this.#selections, id).set(bot, names);
    for (const [bot, name] of dropped) this.#deny(id, bot, name);
    this.#retireUnselected(id);
    return { server: this.#summary(state), tools: this.#visible(planned) };
  }

  #instanceReview(botId: string): McpInstanceSelectionReview {
    const {store,gateway}=this.#admitted();
    const bot=store.getBot(botId);if(bot.ownerId!==store.ownerId)fail("scope_mismatch");
    const head=this.#db?.prepare("SELECT * FROM instance_selection_heads WHERE bot_id=?").get(bot.id);
    if(head&&head.profile_id!==bot.profileId)fail("scope_mismatch");
    const instances: McpInstanceSelectionReview["instances"]=[];
    const selected: McpInstanceSelectionReview["selected"]=[];
    const grantPins: unknown[]=[],unavailableInstances:McpInstanceSelectionReview["unavailableInstances"]=[];
    for(const [serverId,state] of [...this.#servers].sort(([a],[b])=>a.localeCompare(b))){
      const names=[...(this.#selections.get(serverId)?.get(bot.id)??[])].sort();
      const connectionId=this.#connections.get(serverId)?.get(bot.profileId),c=connectionId?gateway.registry.getConnection(connectionId):null;
      if(names.length&&(!c||c.profileId!==bot.profileId))fail("scope_mismatch");
      if(c&&c.installationId===store.hostId&&c.ownerId===store.ownerId&&c.profileId===bot.profileId&&c.toolkit===mcpToolkit(serverId)){
        if(names.length)selected.push({serverId,connectionId:c.id,toolIds:names});
        for(const t of state.tools??[])if(t.state==="publishable")grantPins.push({serverId,toolId:t.id,connectionId:c.id,grant:this.#selectionGrant(bot.id,t.id,c.id)});
        if(c.status==="active"&&state.status==="ready"&&state.generation&&this.#authSupported(state.definition)&&placementAllowed(state.definition,this.#host))
          instances.push({serverId,generation:state.generation,instancePin:this.#adminPort.instancePin(serverId),configurationPin:this.#adminPort.configurationPin(serverId),connectionId:c.id,connectionRevision:c.revision});
        else if(c.status==="active")unavailableInstances.push({serverId,reason:"catalog_or_generation_unavailable"});
      }
    }
    if(instances.length>32||selected.reduce((n,t)=>n+t.toolIds.length,0)>256)fail("server_limit");
    const revision=Number(head?.revision??0),inventoryPin=mcpSetupHash({instances,unavailableInstances});
    return {botId:bot.id,profileId:bot.profileId,revision,inventoryPin,
      selectionPin:mcpSetupHash({revision,selected,grantPins}),instances,selected,unavailableInstances,authenticatedSubject:"unverified"};
  }
  #selectionGrant(botId: string,tool: string,destination: string): McpInstanceSelectionStep["before"] {
    const grant=this.#store!.getGrant(botId,tool,destination);
    if(!grant)return null;
    if(!Number.isSafeInteger(grant.revision)||Number(grant.revision)<1)fail("store_conflict");
    return {revision:grant.revision!,policy:grant.policy,expiresAt:grant.expiresAt};
  }
  #instancePlan(botId: string,input: unknown): McpInstanceSelectionPlan {
    const parsed=McpInstanceSelectionInputSchema.safeParse(input);if(!parsed.success) return fail("invalid_request");
    const body=parsed.data,review=this.#instanceReview(botId);
    if(body.mode==="all_connected"&&review.unavailableInstances.length)fail("catalog_unavailable");
    if(body.expectedRevision!==review.revision||body.expectedInventoryPin!==review.inventoryPin||body.expectedSelectionPin!==review.selectionPin)fail("store_conflict");
    const targets=body.instances.map(t=>{
      const instance=review.instances.find(s=>s.serverId===t.serverId);if(!instance)return fail("scope_mismatch");
      const names=new Set((this.#require(t.serverId).tools??[]).filter(v=>v.state==="publishable").map(v=>v.id));
      if(t.toolIds.some(n=>!names.has(n)))fail("tool_not_allowed");
      return {...instance,toolIds:t.toolIds};
    }).sort((a,b)=>a.serverId.localeCompare(b.serverId));
    if(body.mode==="all_connected"&&targets.map(t=>t.serverId).join("\0")!==review.instances.map(t=>t.serverId).join("\0"))fail("store_conflict");
    const plan=McpInstanceSelectionPlanSchema.safeParse({version:1,mode:body.mode,inventoryPin:review.inventoryPin,selectionPin:review.selectionPin,expectedRevision:review.revision,targets});
    if(!plan.success)return fail("invalid_request");
    return plan.data;
  }
  #instanceAction(actionId: string,read=false) {
    const {store}=this.#admitted();
    if(!store.getAction||!store.toolActionOrigin||!store.ownerToolScope||!store.assertActiveWriter)fail("scope_mismatch");
    store.assertActiveWriter!();const action=store.getAction!(actionId),origin=store.toolActionOrigin!(actionId);
    if(!origin||action.request.tool!=="dexter.harness.mcp.select_instances"||action.request.destination!=="dexter-harness-owner-proposals"
      ||action.decidedBy!==store.ownerId||action.authorization?.source!=="exact_owner"
      ||(read?!["running","succeeded","unknown","blocked"].includes(action.state):action.state!=="running"))fail("scope_mismatch");
    if(!read)store.ownerToolScope!(actionId);
    const bot=store.getBot(action.request.botId);
    if(bot.ownerId!==store.ownerId||bot.profileId!==origin!.profileId)fail("scope_mismatch");
    const plan=McpInstanceSelectionPlanSchema.safeParse(object(action.request.arguments.input).selectionPlan);
    if(!plan.success)return fail("invalid_request");
    return {action,bot,plan:plan.data,originHash:mcpSetupHash({installationId:store.hostId,ownerId:store.ownerId,botId:bot.id,profileId:bot.profileId,
      threadId:action.request.threadId,turnId:origin!.turnId,callId:origin!.callId,actionId})};
  }
  #instanceReceipt(actionId: string): McpInstanceSelectionOutcome|null {
    const binding=this.#instanceAction(actionId,true),db=this.#db;if(!db)return null;
    this.#checkReceiptStore(db);
    const row=db.prepare("SELECT * FROM instance_selection_receipts WHERE action_id=?").get(actionId);if(!row)return null;
    const j=readMcpInstanceSelectionRow(row);
    if(j.hubRequestHash!==binding.action.requestHash||j.originHash!==binding.originHash||j.botId!==binding.bot.id||j.profileId!==binding.bot.profileId
      ||mcpSetupHash(j.plan)!==mcpSetupHash(binding.plan))fail("scope_mismatch");
    const matchingStepStates=j.steps.filter(s=>this.#instanceStepApplied(j.botId,s)).length;
    let matches=matchingStepStates===j.steps.length&&j.retainedGrants.every(g=>mcpSetupHash(this.#selectionGrant(j.botId,g.toolId,g.connectionId))===mcpSetupHash(g.grant));
    const desired=new Map(j.plan.targets.map(t=>[t.serverId,t.toolIds]));
    for(const [id] of this.#servers)if(mcpSetupHash(this.#selections.get(id)?.get(j.botId)??[])!==mcpSetupHash(desired.get(id)??[]))matches=false;
    for(const target of j.plan.targets){const c=this.#gateway!.registry.getConnection(target.connectionId);if(!c||c.status!=="active"||c.revision!==target.connectionRevision
      ||this.#connections.get(target.serverId)?.get(j.profileId)!==c.id||this.#active(target.serverId)?.generation!==target.generation
      ||this.#adminPort.configurationPin(target.serverId)!==target.configurationPin)matches=false;
      for(const tool of target.toolIds){const g=this.#selectionGrant(j.botId,tool,target.connectionId);if(!g||g.policy==="deny"||g.expiresAt!==null&&g.expiresAt<=Date.now())matches=false;}
    }
    return {receipt:j,current:matches?"matches":"changed",matchingStepStates,totalSteps:j.steps.length,replayed:true,grantsReplayed:false,authenticationVerified:false};
  }
  #instanceStepApplied(botId: string,s:McpInstanceSelectionStep):boolean {
    const g=this.#selectionGrant(botId,s.toolId,s.connectionId);
    return g?.revision===(s.before?.revision??0)+1&&g.policy===s.policy&&g.expiresAt===null;
  }
  #applyInstances(actionId: string): McpInstanceSelectionOutcome {
    // A persisted original plan is history: replay never repairs grants, even after denial or restart.
    const previous=this.#instanceReceipt(actionId);if(previous)return previous;
    const {store,gateway}=this.#admitted(),binding=this.#instanceAction(actionId),plan=binding.plan;
    const review=this.#instanceReview(binding.bot.id);
    if(review.revision!==plan.expectedRevision||review.inventoryPin!==plan.inventoryPin||review.selectionPin!==plan.selectionPin)fail("store_conflict");
    const rematerialized=this.#instancePlan(binding.bot.id,{mode:plan.mode,expectedInventoryPin:plan.inventoryPin,expectedSelectionPin:plan.selectionPin,
      expectedRevision:plan.expectedRevision,instances:plan.targets.map(t=>({serverId:t.serverId,toolIds:t.toolIds}))});
    if(mcpSetupHash(rematerialized)!==mcpSetupHash(plan))fail("store_conflict");
    const pairs=new Set(plan.targets.flatMap(t=>t.toolIds.map(n=>n+"\0"+t.connectionId))),steps:McpInstanceSelectionStep[]=[];
    for(const old of review.selected)for(const toolId of old.toolIds)if(!pairs.has(toolId+"\0"+old.connectionId)){
      const before=this.#selectionGrant(binding.bot.id,toolId,old.connectionId);if(before&&before.policy!=="deny")steps.push({serverId:old.serverId,toolId,connectionId:old.connectionId,policy:"deny",before});
    }
    const oldPairs=new Set(review.selected.flatMap(t=>t.toolIds.map(n=>n+"\0"+t.connectionId)));
    const retainedGrants:McpInstanceSelectionJournal["retainedGrants"]=[];
    for(const t of plan.targets)for(const toolId of t.toolIds){const before=this.#selectionGrant(binding.bot.id,toolId,t.connectionId);
      if(!before||before.policy==="deny"||!oldPairs.has(toolId+"\0"+t.connectionId)&&before.policy==="allow")
        steps.push({serverId:t.serverId,toolId,connectionId:t.connectionId,policy:"ask",before});
      else retainedGrants.push({toolId,connectionId:t.connectionId,grant:before});
    }
    const j:McpInstanceSelectionJournal={version:1,operation:"mcp.select_instances",receiptId:randomUUID(),actionId,hubRequestHash:binding.action.requestHash,
      originHash:binding.originHash,requestHash:mcpSetupHash({operation:"mcp.select_instances",plan}),botId:binding.bot.id,profileId:binding.bot.profileId,
      revision:plan.expectedRevision+1,plan,steps,retainedGrants,phase:"pending",code:null,createdAt:Date.now()};
    this.#write(db=>{
      if(Number(db.prepare("SELECT COUNT(*) AS n FROM instance_selection_receipts").get()!.n)>=MCP_INSTANCE_SELECTION_RECEIPT_LIMIT)fail("server_limit");
      if(!db.prepare("SELECT bot_id FROM instance_selection_heads WHERE bot_id=?").get(j.botId)&&Number(db.prepare("SELECT COUNT(*) AS n FROM instance_selection_heads").get()!.n)>=MCP_INSTANCE_SELECTION_HEAD_LIMIT)fail("server_limit");
      this.#instanceAction(actionId);
      for(const [serverId] of this.#servers){const toolIds=plan.targets.find(t=>t.serverId===serverId)?.toolIds??[];
        db.prepare("INSERT INTO selections VALUES(?,?,?) ON CONFLICT(server_id,bot_id) DO UPDATE SET tools=excluded.tools").run(serverId,j.botId,JSON.stringify(toolIds));}
      db.prepare("INSERT INTO instance_selection_heads VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET profile_id=excluded.profile_id,revision=excluded.revision,selection_hash=excluded.selection_hash")
        .run(j.botId,j.profileId,j.revision,mcpSetupHash(plan.targets));
      putMcpInstanceSelectionJournal(db,j);
    });
    for(const [serverId] of this.#servers)this.#mapOf(this.#selections,serverId).set(j.botId,plan.targets.find(t=>t.serverId===serverId)?.toolIds??[]);
    try {
      for(const t of plan.targets)for(const name of t.toolIds){this.#instanceAction(actionId);const manifest=this.#require(t.serverId).tools?.find(v=>v.id===name)?.manifest;
        if(!manifest)fail("tool_changed");gateway.registerTool(manifest);}
      for(const step of steps){this.#instanceAction(actionId);this.#fenced();
        if(mcpSetupHash(this.#selectionGrant(j.botId,step.toolId,step.connectionId))!==mcpSetupHash(step.before))fail("store_conflict");
        store.setGrant({botId:j.botId,tool:step.toolId,destination:step.connectionId,policy:step.policy,expiresAt:null});
        if(!this.#instanceStepApplied(j.botId,step))fail("store_conflict");
      }
      this.#instanceAction(actionId);
      for(const [id]of this.#servers)this.#retireUnselected(id);
      const done={...j,phase:"completed" as const};this.#write(db=>putMcpInstanceSelectionJournal(db,done));
      const result=this.#instanceReceipt(actionId)!;return {...result,replayed:false};
    }catch{
      // A new exact approval may reconcile the CURRENT state. This original operation never resumes on replay/bind.
      const partial={...j,phase:"partial" as const,code:"interrupted" as const};
      try{this.#write(db=>putMcpInstanceSelectionJournal(db,partial));}catch{/* Durable pending remains honest when writer authority was lost. */}
      throw new McpConnectorError("store_conflict","selection_partial_read_original");
    }
  }

  #selection(id: string, botId: string): McpBotSelection {
    this.#admitted();
    this.#require(id);
    if (typeof botId !== "string" || !BOT_ID.test(botId)) fail("bot_unknown");
    return { botId, toolIds: [...(this.#selections.get(id)?.get(botId) ?? [])], policy: "ask" };
  }

  #select(id: string, botId: string, input: unknown): McpBotSelection {
    const { store, gateway } = this.#admitted();
    const state = this.#require(id);
    if (typeof botId !== "string" || !BOT_ID.test(botId)) fail("bot_unknown");
    const body = object(input);
    exactKeys(body, ["toolIds", "policy"]);
    if (body.policy !== "ask") fail("invalid_request");
    const raw = body.toolIds;
    if (!Array.isArray(raw) || raw.length > MAX_SELECTED || !raw.every((t) => typeof t === "string")) fail("invalid_request");
    const toolIds = [...new Set(raw as string[])].sort();
    const definition = state.definition;
    if (!this.#authSupported(definition) || !placementAllowed(definition, this.#host)) fail("catalog_unavailable");
    // Selections apply only to the reviewed, current catalog. Upstream annotations never decide anything here.
    const catalogTools = state.status === "ready" ? state.tools : null;
    if (!catalogTools) return fail("catalog_unavailable");
    const publishable = new Map(catalogTools.filter((t) => t.state === "publishable" && t.manifest).map((t) => [t.id, t.manifest!]));
    if (toolIds.some((t) => !publishable.has(t))) fail("tool_not_allowed");
    let bot: { id: string; profileId: string; ownerId: string };
    try { bot = store.getBot(botId); } catch { return fail("bot_unknown"); }
    if (bot.ownerId !== store.ownerId) fail("bot_unknown");
    this.#fenced();

    // Connection of the bot's profile (connecting grants nothing by itself).
    let connectionId = this.#connections.get(id)?.get(bot.profileId);
    const live = connectionId ? gateway.registry.getConnection(connectionId) : null;
    if (!connectionId || live?.status !== "active") {
      connectionId = gateway.connectAccount(mcpConnectInput(definition, { profileId: bot.profileId, label: definition.name, credentialRef: credentialRef(definition) })).id;
      const created = connectionId;
      this.#write((db) => {
        db.prepare("INSERT INTO connections (server_id, profile_id, connection_id) VALUES (?, ?, ?) ON CONFLICT (server_id, profile_id) DO UPDATE SET connection_id=excluded.connection_id")
          .run(id, bot.profileId, created);
      });
      this.#mapOf(this.#connections, id).set(bot.profileId, created);
    }
    const previous = this.#selections.get(id)?.get(bot.id) ?? [];
    // Intent first: after a crash the restart reconciliation turns any grant outside the stored selection into deny.
    this.#write((db) => {
      db.prepare("INSERT INTO selections (server_id, bot_id, tools) VALUES (?, ?, ?) ON CONFLICT (server_id, bot_id) DO UPDATE SET tools=excluded.tools")
        .run(id, bot.id, JSON.stringify(toolIds));
    });
    this.#mapOf(this.#selections, id).set(bot.id, toolIds);
    for (const name of previous) if (!toolIds.includes(name)) this.#deny(id, bot.id, name);
    for (const name of toolIds) {
      gateway.registerTool(publishable.get(name)!); // identical re-pin is a no-op
      const grant = store.getGrant(bot.id, name, connectionId);
      if (!grant || grant.policy !== "ask" || grant.expiresAt !== null) store.setGrant({ botId: bot.id, tool: name, destination: connectionId, policy: "ask" });
    }
    this.#retireUnselected(id);
    return { botId: bot.id, toolIds: [...toolIds], policy: "ask" };
  }

  async #remove(id: string): Promise<{ removed: true }> {
    const state = this.#require(id);
    this.#fenced();
    // Persist the intent first: sources refuse at once, and an interrupted removal is finished on restart.
    this.#write((db) => { db.prepare("UPDATE servers SET status='deleting' WHERE id=?").run(state.definition.id); });
    state.status = "deleting";
    this.#vault?.lock(state.definition.id);
    const connections = this.#finishRevocation(state.definition.id);
    await Promise.allSettled(connections.map((c) => this.#inner.closeConnection(c)));
    // OAuth tokens of a removed server are deleted from the token store too (no remote revocation).
    await this.#oauth?.disconnect(state.definition.id).catch(() => undefined);
    this.#dropRows(state.definition.id);
    return { removed: true };
  }
  #finishRemoval(id: string): void {
    this.#finishRevocation(id);
    this.#dropRows(id);
    const oauth = this.#oauth;
    if (oauth) {
      const run = oauth.disconnect(id).catch(() => undefined);
      this.#work.add(run);
      void run.then(() => this.#work.delete(run));
    }
  }
  /** Revokes every gateway connection of the server's toolkit, denies selected grants, retires its manifests. Idempotent. */
  #finishRevocation(id: string): string[] {
    const gateway = this.#gateway!;
    const toolkit = mcpToolkit(id);
    const revoked = new Set<string>(this.#connections.get(id)?.values() ?? []);
    for (const connection of gateway.registry.listConnections()) if (connection.toolkit === toolkit) revoked.add(connection.id);
    for (const connectionId of revoked) {
      const live = gateway.registry.getConnection(connectionId);
      if (live && live.status === "active") gateway.revokeConnection(connectionId);
    }
    for (const [bot, names] of this.#selections.get(id) ?? []) for (const name of names) this.#deny(id, bot, name);
    for (const tool of gateway.registry.listTools()) {
      if (tool.manifest.toolkit === toolkit && tool.status === "active") gateway.retireTool(tool.manifest.name);
    }
    return [...revoked];
  }
  #dropRows(id: string): void {
    this.#write((db) => {
      for (const table of ["selections", "connections", "catalogs"]) db.prepare(`DELETE FROM ${table} WHERE server_id=?`).run(id);
      db.prepare("DELETE FROM servers WHERE id=?").run(id);
      db.prepare("DELETE FROM meta WHERE key=?").run(`mcp-diagnostic:${id}`);
      db.prepare("DELETE FROM meta WHERE key=?").run(`mcp-instance:${id}`);
    });
    this.#servers.delete(id);
    this.#connections.delete(id);
    this.#selections.delete(id);
    // The server's private HOME/TMPDIR under Dexter's stdio root (never the owner's home).
    if (MCP_ID.test(id)) rmSync(join(this.#host.stdioRoot, id), { recursive: true, force: true });
  }
  #deny(id: string, botId: string, name: string): void {
    const store = this.#store!;
    const connectionIds = new Set<string>(this.#connections.get(id)?.values() ?? []);
    for (const connectionId of connectionIds) {
      const grant = store.getGrant(botId, name, connectionId);
      if (grant && grant.policy !== "deny") store.setGrant({ botId, tool: name, destination: connectionId, policy: "deny" });
    }
  }
  /** Manifests of this server stay registered only while some bot selects them. */
  #retireUnselected(id: string): void {
    const gateway = this.#gateway!;
    const selected = new Set([...(this.#selections.get(id)?.values() ?? [])].flat());
    for (const tool of gateway.registry.listTools()) {
      if (tool.manifest.toolkit === mcpToolkit(id) && tool.status === "active" && !selected.has(tool.manifest.name)) gateway.retireTool(tool.manifest.name);
    }
  }
  /** Restart: re-pin selected reviewed manifests, deny stray grants, retire unselected. Starts nothing. */
  #reconcile(id: string): void {
    const state = this.#servers.get(id)!;
    const gateway = this.#gateway!;
    const publishable = new Map((state.tools ?? []).filter((t) => t.state === "publishable" && t.manifest).map((t) => [t.id, t.manifest!]));
    const selections = this.#selections.get(id) ?? new Map<string, string[]>();
    for (const [bot, names] of selections) {
      const kept = names.filter((n) => publishable.has(n));
      if (kept.length !== names.length) {
        this.#write((db) => { db.prepare("UPDATE selections SET tools=? WHERE server_id=? AND bot_id=?").run(JSON.stringify(kept), id, bot); });
        selections.set(bot, kept);
      }
      for (const name of kept) gateway.registerTool(publishable.get(name)!);
      for (const name of publishable.keys()) if (!kept.includes(name)) this.#deny(id, bot, name);
    }
    this.#retireUnselected(id);
  }

  // ---- gateway ports ---------------------------------------------------------------------------

  #credential(ref: string, host: string): InjectedAuth | null {
    if (typeof ref !== "string" || typeof host !== "string") return null;
    const parsed = parseCredentialRef(ref);
    const state = parsed ? this.#active(parsed.id) : null;
    // Only the server's own reference (of its own auth mode) and logical host. auth:none gets an empty entry; broker the
    // unlocked custody values; OAuth the bound access token. Locked/expired: null, the gateway keeps the action ready.
    if (!parsed || !state || serverIdOfHost(host) !== parsed.id || state.definition.auth !== parsed.auth || !this.#authSupported(state.definition)) return null;
    // Only a gateway call may start a background refresh of an expired OAuth token; listing never does.
    const credential = this.#credentialOf(state.definition, true);
    return credential === null ? null : Object.freeze({ headers: credential });
  }

  // ---- credentials -----------------------------------------------------------------------------

  #authSupported(definition: McpServerDefinition): boolean {
    return definition.auth === "none" || (definition.auth === "broker" ? this.#vault !== null : this.#oauth !== null);
  }
  /** Session credential for the definition from memory only (never a custody read here), or null. */
  #credentialOf(definition: McpServerDefinition, refreshExpired = false): McpCredential | null {
    if (definition.auth === "none") return Object.freeze({});
    if (definition.auth === "broker") return this.#vault?.credential(definition.id) ?? null;
    const token = this.#oauth?.access(definition, refreshExpired) ?? null;
    return token === null ? null : Object.freeze({ [MCP_OAUTH_ACCESS_KEY]: token });
  }
  async #unlockOf(definition: McpServerDefinition): Promise<void> {
    try {
      if (definition.auth === "broker") await this.#vault!.unlock(definition, this.#abort.signal);
      else if (definition.auth === "oauth") await this.#oauth!.restore(definition);
      this.#credentialErrors.delete(definition.id);
    } catch (error) {
      const code = error instanceof McpConnectorError ? error.code : "custody_unavailable";
      this.#credentialErrors.set(definition.id, code);
      throw new McpConnectorError(code);
    }
  }
  #credentialStatus(s: ServerState): McpCredentialStatus {
    const d = s.definition;
    const base = { serverId: d.id, auth: d.auth, slots: secretSlotsOf(d).map((x) => x.key), lastError: this.#credentialErrors.get(d.id) ?? null };
    if (d.auth === "none") return { ...base, custody: null, state: "not_required", expiresAt: null, issuer: null };
    if (d.auth === "broker") {
      if (!this.#vault) return { ...base, custody: null, state: "unavailable", expiresAt: null, issuer: null };
      const v = this.#vault.status(d.id);
      return { ...base, custody: this.#vault.kind, state: v.state, expiresAt: v.expiresAt, issuer: null };
    }
    if (!this.#oauth || !placementAllowed(d, this.#host)) return { ...base, custody: null, state: "unavailable", expiresAt: null, issuer: null };
    const o = this.#oauth.status(d);
    return {
      ...base, custody: "oauth", state: o.state === "none" ? "unauthorized" : o.state === "authorized" ? "unlocked" : o.state, expiresAt: o.expiresAt, issuer: o.issuer,
      lastError: o.lastError ?? base.lastError,
    };
  }
  async #unlock(id: string): Promise<McpCredentialStatus> {
    const state = this.#require(id);
    if (!this.#authSupported(state.definition) || !placementAllowed(state.definition, this.#host)) return this.#credentialStatus(state);
    if (state.definition.auth !== "none") await this.#unlockOf(state.definition);
    if (this.#active(state.definition.id) !== state) fail("server_unknown");
    return this.#credentialStatus(state);
  }
  async #lock(id: string, disconnect: boolean): Promise<McpCredentialStatus> {
    const state = this.#require(id);
    const d = state.definition;
    if (d.auth === "broker") this.#vault?.lock(d.id);
    if (d.auth === "oauth" && this.#oauth) {
      if (disconnect) await this.#oauth.disconnect(d.id);
      else this.#oauth.lock(d.id);
    }
    this.#credentialErrors.delete(d.id);
    // Sessions opened with the dropped values end now; a call in flight becomes unknown at the hub, never retried.
    await Promise.allSettled([...(this.#connections.get(d.id)?.values() ?? [])].map((c) => this.#inner.closeConnection(c)));
    return this.#credentialStatus(state);
  }
  async #startOAuth(id: string, input: unknown): Promise<McpOAuthStart> {
    const state = this.#require(id);
    const body = object(input);
    if (Object.keys(body).some((k) => k !== "clientId" && k !== "scope")) fail("invalid_request");
    const d = state.definition;
    if (d.auth !== "oauth" || !this.#oauth) return fail("oauth_unavailable");
    if (!placementAllowed(d, this.#host)) return fail("placement_unavailable");
    this.#fenced();
    const started = await this.#oauth.begin(d, {
      ...(body.clientId === undefined ? {} : { clientId: body.clientId as string }),
      ...(body.scope === undefined ? {} : { scope: body.scope as string }),
    }, this.#abort.signal);
    if (this.#active(d.id) !== state) { this.#oauth.lock(d.id); fail("server_unknown"); }
    return started;
  }

  #execute(call: AdapterCall, auth: InjectedAuth, context: { signal: AbortSignal }): Promise<JsonValue> {
    if (this.#refusing || this.#closed) return Promise.reject(new McpConnectorError("closed"));
    if (!this.#store) return Promise.reject(new McpConnectorError("unbound"));
    const id = serverIdOfHost(call.host);
    const state = id === null ? null : this.#active(id);
    if (!state || id === null) return Promise.reject(new McpConnectorError("server_unknown"));
    // The connection must be the one this manager created for the capability's own profile.
    if (this.#connections.get(id)?.get(call.scope.profileId) !== call.connectionId) return Promise.reject(new McpConnectorError("scope_mismatch"));
    const signal = AbortSignal.any([context.signal, this.#abort.signal]);
    const run = this.#inner.execute(call, auth, { signal });
    this.#work.add(run);
    void run.then(() => this.#work.delete(run), () => this.#work.delete(run));
    return run;
  }
}

/** Gateway hosts served by the native MCP runtime. */
export const isNativeMcpHost = (host: string): boolean => serverIdOfHost(host) !== null;
export const isNativeMcpCredentialRef = (ref: string): boolean => typeof ref === "string" && parseCredentialRef(ref) !== null;
