import { inspect } from "node:util";
import { OpenVikingAdapter } from "./openviking-adapter.js";
import { assertOpenVikingBotIdentity, encodeOpenVikingHostId, validateOpenVikingUserKey } from "./openviking-identity.js";
import type { OpenVikingBotIdentity } from "./openviking-identity.js";
import { OpenVikingError, OpenVikingHttpTransport, openVikingRecord, openVikingResult } from "./openviking-http.js";
import type { OpenVikingCallOptions, OpenVikingHttpOptions } from "./openviking-http.js";

export interface OpenVikingProvisioningBinding {
  operationKey: string; kind: "account" | "bot_user"; accountId: string; userId: string;
}
export interface OpenVikingProvisioningReceipt extends OpenVikingProvisioningBinding {
  outcome: "account_exists" | "identity_verified" | "unknown" | "credential_required" | "blocked_configuration";
  content: "unproven"; indexing: "unproven";
}
export interface OpenVikingProvisioningJournal {
  /** Durable host-only administrative intent. Exact binding; send once; existing/unknown only reconcile. */
  claim(binding: OpenVikingProvisioningBinding): Promise<"send" | "reconcile">;
  record(receipt: OpenVikingProvisioningReceipt): Promise<void>;
}
export interface OpenVikingCredentialCustody {
  /** Private host storage only. Values are excluded from receipts, JSON, public logs and content backups. */
  load(identity: OpenVikingBotIdentity): Promise<string | null>;
  save(identity: OpenVikingBotIdentity, userKey: string): Promise<void>;
}
export interface OpenVikingProvisionerOptions extends OpenVikingHttpOptions {
  rootCredential: () => string | Promise<string>;
  /** Explicit host-only authority. Workspace admins can provision only users in their fixed Dexter account.
   * Account creation remains ROOT-only; neither credential is ever supplied to data/recall APIs. */
  administrativeRole?: "root" | "workspace_admin";
  journal: OpenVikingProvisioningJournal;
  custody: OpenVikingCredentialCustody;
}
const disabledPolicy = Object.freeze({ self: { enabled: false }, peer: { enabled: false }, working_memory: { enabled: false }, memory_types: [] });

/** Host bootstrap only. This object is never registered as a model/MCP tool and cannot use root for data APIs. */
export class OpenVikingProvisioner {
  readonly #http: OpenVikingHttpTransport;
  readonly #options: OpenVikingProvisionerOptions;
  #closed = false;
  constructor(options: OpenVikingProvisionerOptions) {
    if (typeof options.rootCredential !== "function" || !options.custody || !options.journal) throw new OpenVikingError("configuration");
    if (options.administrativeRole !== undefined && !["root", "workspace_admin"].includes(options.administrativeRole)) throw new OpenVikingError("configuration");
    this.#options = { ...options };
    this.#http = new OpenVikingHttpTransport(options);
  }
  toJSON(): { role: "host_only_provisioner"; origin: string } { return { role: "host_only_provisioner", origin: this.#http.origin }; }
  [inspect.custom](): string { return `OpenVikingProvisioner(${this.#http.origin})`; }
  close(): void { this.#closed = true; this.#http.close(); }

  async #root(options: OpenVikingCallOptions, identity?: OpenVikingBotIdentity): Promise<string> {
    if (this.#closed) throw new OpenVikingError("closed");
    let key: unknown;
    try { key = await this.#options.rootCredential(); } catch { throw new OpenVikingError("identity"); }
    if (typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new OpenVikingError("identity");
    const response = await this.#http.request("GET", "/health", key, undefined, options);
    const health = openVikingRecord(response.body);
    if (response.status !== 200 || health.status !== "ok" || health.healthy !== true || health.auth_mode !== "api_key") throw new OpenVikingError("identity");
    if (this.#options.administrativeRole === "workspace_admin") {
      if (!identity || health.role !== "admin" || health.account_id !== identity.accountId
        || health.user_id !== `svc1_${encodeOpenVikingHostId(identity.workspaceId)}`) throw new OpenVikingError("identity");
    } else if (health.role !== "root") throw new OpenVikingError("identity");
    return key;
  }
  #binding(identity: OpenVikingBotIdentity, operationKey: string, kind: OpenVikingProvisioningBinding["kind"]): OpenVikingProvisioningBinding {
    try { assertOpenVikingBotIdentity(identity); } catch { throw new OpenVikingError("identity"); }
    if (typeof operationKey !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(operationKey)) throw new OpenVikingError("input");
    return Object.freeze({ operationKey, kind, accountId: identity.accountId,
      userId: kind === "account" ? `svc1_${encodeOpenVikingHostId(identity.workspaceId)}` : identity.userId });
  }
  async #claim(binding: OpenVikingProvisioningBinding): Promise<"send" | "reconcile"> {
    let state: unknown;
    try { state = await this.#options.journal.claim(binding); } catch { throw new OpenVikingError("journal"); }
    if (state !== "send" && state !== "reconcile") throw new OpenVikingError("journal");
    return state;
  }
  async #finish(binding: OpenVikingProvisioningBinding, outcome: OpenVikingProvisioningReceipt["outcome"]): Promise<OpenVikingProvisioningReceipt> {
    const receipt: OpenVikingProvisioningReceipt = Object.freeze({ ...binding, outcome, content: "unproven", indexing: "unproven" });
    try { await this.#options.journal.record(receipt); } catch { throw new OpenVikingError("journal"); }
    return receipt;
  }
  async #accounts(key: string, binding: OpenVikingProvisioningBinding, options: OpenVikingCallOptions): Promise<boolean> {
    const query = new URLSearchParams({ name: binding.accountId, limit: "2", page: "1" });
    const accounts = openVikingResult(await this.#http.request("GET", `/api/v1/admin/accounts?${query}`, key, undefined, options));
    if (!Array.isArray(accounts) || accounts.length > 1) throw new OpenVikingError("protocol");
    if (accounts.length && openVikingRecord(accounts[0]).account_id !== binding.accountId) throw new OpenVikingError("identity");
    return accounts.length === 1;
  }
  async ensureAccount(identity: OpenVikingBotIdentity, operationKey: string, options: OpenVikingCallOptions = {}): Promise<OpenVikingProvisioningReceipt> {
    const binding = this.#binding(identity, operationKey, "account");
    if (this.#options.administrativeRole === "workspace_admin") throw new OpenVikingError("identity");
    const key = await this.#root(options);
    const disposition = await this.#claim(binding);
    try {
      if (await this.#accounts(key, binding, options)) return await this.#finish(binding, "account_exists");
      if (disposition === "reconcile") return await this.#finish(binding, "unknown");
      const created = openVikingRecord(openVikingResult(await this.#http.request("POST", "/api/v1/admin/accounts", key,
        { account_id: binding.accountId, admin_user_id: binding.userId, user_config: { memory_policy: disabledPolicy } }, options)));
      if (created.account_id !== binding.accountId || created.admin_user_id !== binding.userId) throw new OpenVikingError("identity");
      // First-admin keys, if returned, are deliberately not data credentials. ROOT stays in private host custody.
      return await this.#finish(binding, await this.#accounts(key, binding, options) ? "account_exists" : "unknown");
    } catch (error) {
      if (error instanceof OpenVikingError && error.code === "journal") throw error;
      return await this.#finish(binding, "unknown");
    }
  }
  async ensureBot(identity: OpenVikingBotIdentity, operationKey: string, options: OpenVikingCallOptions = {}): Promise<OpenVikingProvisioningReceipt> {
    const binding = this.#binding(identity, operationKey, "bot_user");
    const key = await this.#root(options, identity);
    const disposition = await this.#claim(binding);
    const path = `/api/v1/admin/accounts/${binding.accountId}/users`;
    try {
      const query = new URLSearchParams({ name: binding.userId, limit: "2", page: "1", include_credentials: "false" });
      const users = openVikingResult(await this.#http.request("GET", `${path}?${query}`, key, undefined, options));
      if (!Array.isArray(users) || users.length > 1) throw new OpenVikingError("protocol");
      let userKey = await this.#options.custody.load(identity);
      if (users.length) {
        const user = openVikingRecord(users[0]);
        if (user.user_id !== identity.userId || user.role !== "user") throw new OpenVikingError("identity");
      } else {
        if (disposition === "reconcile") return await this.#finish(binding, "unknown");
        const created = openVikingRecord(openVikingResult(await this.#http.request("POST", path, key,
          { user_id: identity.userId, role: "user", user_config: { memory_policy: disabledPolicy } }, options)));
        if (created.account_id !== identity.accountId || created.user_id !== identity.userId) throw new OpenVikingError("identity");
        if (typeof created.user_key !== "string") return await this.#finish(binding, "credential_required");
        userKey = created.user_key;
        try { validateOpenVikingUserKey(userKey, identity); } catch { throw new OpenVikingError("identity"); }
        // Save before a subsequent response can be lost; private storage is not a receipt or public event.
        await this.#options.custody.save(identity, userKey);
      }
      if (userKey === null) return await this.#finish(binding, "credential_required");
      const settings = openVikingRecord(openVikingResult(await this.#http.request("GET", `${path}/${binding.userId}/settings`, key, undefined, options)));
      if (settings.account_id !== identity.accountId || settings.user_id !== identity.userId) throw new OpenVikingError("identity");
      const policy = openVikingRecord(settings.memory_policy);
      if (openVikingRecord(policy.self).enabled !== false || openVikingRecord(policy.peer).enabled !== false ||
        openVikingRecord(policy.working_memory).enabled !== false || !Array.isArray(policy.memory_types) || policy.memory_types.length) return await this.#finish(binding, "blocked_configuration");
      const adapter = new OpenVikingAdapter({ origin: this.#http.origin, identity, credential: () => userKey!,
        timeoutMs: this.#options.timeoutMs ?? 10_000, maxResponseBytes: this.#options.maxResponseBytes ?? 1_048_576,
        fetch: this.#options.fetch ?? ((url, init) => fetch(url, init)) });
      try { await adapter.status(options); } finally { adapter.close(); }
      return await this.#finish(binding, "identity_verified");
    } catch (error) {
      if (error instanceof OpenVikingError && error.code === "journal") throw error;
      return await this.#finish(binding, "unknown");
    }
  }
}
