import { dirname } from "node:path";
import type { CredentialBroker, InjectedAuth, UpstreamAdapter, AdapterCall, CapabilityGateway } from "@dexter/gateway";
import type { JsonValue } from "@dexter/contracts";
import { COMPOSIO_ORIGIN, COMPOSIO_DEFAULT_AUTH_HEADERS, ComposioToolAdapter } from "./composio.js";
import { checkAuthHeaders, checkLimits, checkOrigin, type FetchLike, type HttpLimits } from "./http.js";
import { ManagedAppsService, type ManagedAppsHost, type ManagedAppsIdentity, type ManagedAppsProvider } from "./managed-apps.js";
export type ManagedAppsRuntimeErrorCode = "invalid_options" | "unbound" | "already_bound" | "closed" | "identity_mismatch" | "auth_refused" | "drain_failed" | "dispose_failed";
export class ManagedAppsRuntimeError extends Error {
    constructor(readonly code: ManagedAppsRuntimeErrorCode) { super(`managed apps runtime: ${code}`); this.name = "ManagedAppsRuntimeError"; }
}
export interface ManagedAppsRuntimeOptions {
    /** Actual trusted HostStore identity, never supplied by an engine or client. */
    identity: ManagedAppsIdentity;
    provider: ManagedAppsProvider;
    broker: CredentialBroker;
    credentialRef: string;
    fetch: FetchLike;
    origin?: string;
    authHeaders?: readonly string[];
    limits?: Partial<HttpLimits>;
    secretValues?: () => readonly string[];
    /** Explicit transfer of broker disposal responsibility; omitted means caller-owned and never disposed here. */
    disposeOwnedBroker?: () => void | Promise<void>;
}
export type ManagedAppsAdmin = Pick<ManagedAppsService, "syncCatalog" | "catalog" | "catalogRevision" | "approveTools" | "provision" | "operation" | "reconcile" | "refreshAccount" | "revoke" | "grant">;
const fail = (code: ManagedAppsRuntimeErrorCode): never => { throw new ManagedAppsRuntimeError(code); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("invalid_options");
const id = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : fail("invalid_options");
/** Host-only composition. Public adapter/broker are trusted gateway ports, never engine/admin HTTP endpoints. */
export class ManagedAppsRuntime {
    readonly adapter: UpstreamAdapter;
    readonly broker: CredentialBroker;
    readonly #identity: Readonly<ManagedAppsIdentity>;
    readonly #provider: ManagedAppsProvider;
    readonly #credentialRef: string;
    readonly #host: string;
    readonly #upstream: ComposioToolAdapter;
    readonly #acquire: CredentialBroker["acquire"];
    readonly #brokerSecrets: CredentialBroker["secretValues"];
    readonly #extraSecrets: () => readonly string[];
    readonly #dispose: (() => void | Promise<void>) | null;
    readonly #authHeaders: ReadonlySet<string>;
    readonly #abort = new AbortController();
    readonly #executions = new Set<Promise<JsonValue>>();
    readonly #adminPort: Readonly<ManagedAppsAdmin>;
    #service: ManagedAppsService | null = null;
    #closing = false;
    #closed = false;
    #closeFlight: Promise<void> | null = null;
    constructor(options: ManagedAppsRuntimeOptions) {
        try {
            const config = object(options);
            if (Object.keys(config).some(k => !["identity", "provider", "broker", "credentialRef", "fetch", "origin", "authHeaders", "limits", "secretValues", "disposeOwnedBroker"].includes(k)))
                fail("invalid_options");
            // Capture metadata once, then validate only plain snapshots. Keep trusted function receivers intact.
            const rawIdentity = config.identity, rawOrigin = config.origin, rawHeaders = config.authHeaders, rawLimits = config.limits;
            const identity = object(JSON.parse(JSON.stringify(rawIdentity)));
            if (Object.keys(identity).sort().join() !== "installationId,ownerId")
                fail("invalid_options");
            this.#identity = Object.freeze({ installationId: id(identity.installationId), ownerId: id(identity.ownerId) });
            this.#credentialRef = id(config.credentialRef);
            const origin = checkOrigin(rawOrigin === undefined ? COMPOSIO_ORIGIN : typeof rawOrigin === "string" ? rawOrigin : fail("invalid_options"));
            this.#host = new URL(origin).hostname;
            if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(this.#host))
                fail("invalid_options");
            const headers: unknown = JSON.parse(JSON.stringify(rawHeaders ?? COMPOSIO_DEFAULT_AUTH_HEADERS));
            if (!Array.isArray(headers) || headers.length < 1 || headers.length > 8 || headers.some(h => typeof h !== "string" || !["x-api-key", "x-user-api-key"].includes(h)) || new Set(headers).size !== headers.length)
                fail("invalid_options");
            this.#authHeaders = new Set(headers as string[]);
            const limits = rawLimits === undefined ? undefined : object(JSON.parse(JSON.stringify(rawLimits)));
            if (limits && Object.keys(limits).some(k => !["timeoutMs", "maxRequestBytes", "maxResponseBytes"].includes(k)))
                fail("invalid_options");
            const validatedLimits = checkLimits(limits as Partial<HttpLimits> | undefined);
            const provider = object(config.provider), broker = object(config.broker);
            const catalog = provider.catalog, provision = provider.provision, lookup = provider.lookup, account = provider.account;
            const acquire = broker.acquire, secrets = broker.secretValues, fetch = config.fetch, extra = config.secretValues, dispose = config.disposeOwnedBroker;
            if ([catalog, provision, lookup, account, acquire, secrets, fetch].some(fn => typeof fn !== "function") || (extra !== undefined && typeof extra !== "function") || (dispose !== undefined && typeof dispose !== "function"))
                fail("invalid_options");
            this.#provider = Object.freeze({ catalog: (catalog as ManagedAppsProvider["catalog"]).bind(provider), provision: (provision as ManagedAppsProvider["provision"]).bind(provider), lookup: (lookup as ManagedAppsProvider["lookup"]).bind(provider), account: (account as ManagedAppsProvider["account"]).bind(provider) });
            this.#acquire = (acquire as CredentialBroker["acquire"]).bind(broker);
            this.#brokerSecrets = (secrets as CredentialBroker["secretValues"]).bind(broker);
            this.#extraSecrets = extra as (() => readonly string[]) | undefined ?? (() => []);
            this.#dispose = dispose as (() => void | Promise<void>) | undefined ?? null;
            this.#upstream = new ComposioToolAdapter({ sessions: { find: (scope, connectionId) => this.#closing || this.#closed ? null : this.#service?.find(scope, connectionId) ?? null }, fetch: fetch as FetchLike, origin, authHeaders: headers as string[], limits: validatedLimits });
            this.#adminPort = Object.freeze({
                syncCatalog: (revision: number) => this.#adminService().syncCatalog(revision),
                catalog: () => this.#adminService().catalog(),
                catalogRevision: (revision: number) => this.#adminService().catalogRevision(revision),
                approveTools: (revision: number, names: readonly string[]) => this.#adminService().approveTools(revision, names),
                provision: (operationId: string, input: Parameters<ManagedAppsService["provision"]>[1]) => this.#adminService().provision(operationId, input),
                operation: (operationId: string) => this.#adminService().operation(operationId),
                reconcile: (operationId: string) => this.#adminService().reconcile(operationId),
                refreshAccount: (operationId: string) => this.#adminService().refreshAccount(operationId),
                revoke: (operationId: string) => this.#adminService().revoke(operationId),
                grant: (input: Parameters<ManagedAppsService["grant"]>[0]) => this.#adminService().grant(input),
            });
            this.adapter = Object.freeze({ execute: (call: AdapterCall, auth: InjectedAuth, context: {
                    signal: AbortSignal;
                }) => this.#execute(call, auth, context) });
            this.broker = Object.freeze({ acquire: (ref: string, host: string) => this.#credential(ref, host), secretValues: () => this.#secrets() });
            Object.freeze(this);
        }
        catch {
            throw new ManagedAppsRuntimeError("invalid_options");
        }
    }
    toJSON() { return { kind: "host_managed_apps_runtime", ...this.#identity, state: this.#closed ? "closed" : this.#closing ? "closing" : this.#service ? "bound" : "unbound" }; }
    bind(store: ManagedAppsHost, gateway: CapabilityGateway): void {
        if (this.#closing || this.#closed)
            fail("closed");
        if (this.#service)
            fail("already_bound");
        if (store.hostId !== this.#identity.installationId || store.ownerId !== this.#identity.ownerId || gateway.registry.installationId !== store.hostId || gateway.registry.ownerId !== store.ownerId || dirname(gateway.registry.databasePath) !== dirname(store.databasePath))
            fail("identity_mismatch");
        const service = new ManagedAppsService({ store, gateway, provider: this.#provider, credentialRef: this.#credentialRef, upstreamHost: this.#host, secretValues: () => this.#secrets() });
        this.#service = service;
    }
    /** Resolve for each host admin operation; never retain/publish as an engine endpoint. */
    get admin(): Readonly<ManagedAppsAdmin> {
        this.#adminService();
        return this.#adminPort;
    }
    #adminService(): ManagedAppsService {
        if (this.#closing || this.#closed)
            fail("closed");
        return this.#service ?? fail("unbound");
    }
    #secrets(): readonly string[] {
        try {
            const values = [...this.#brokerSecrets(), ...this.#extraSecrets()];
            if (values.some(v => typeof v !== "string"))
                fail("auth_refused");
            return values;
        }
        catch {
            return fail("auth_refused");
        }
    }
    #credential(ref: string, host: string): InjectedAuth | null {
        if (this.#closing || this.#closed || !this.#service || ref !== this.#credentialRef || host !== this.#host)
            return null;
        try {
            const value = this.#acquire(ref, host);
            if (value === null)
                return null;
            const headers = checkAuthHeaders(value.headers, this.#authHeaders);
            return Object.freeze({ headers: Object.freeze(headers) });
        }
        catch {
            return fail("auth_refused");
        }
    }
    #execute(call: AdapterCall, auth: InjectedAuth, context: {
        signal: AbortSignal;
    }): Promise<JsonValue> {
        if (this.#closing || this.#closed)
            return Promise.reject(new ManagedAppsRuntimeError("closed"));
        if (!this.#service)
            return Promise.reject(new ManagedAppsRuntimeError("unbound"));
        const signal = AbortSignal.any([context.signal, this.#abort.signal]);
        const owned = Promise.resolve().then(() => {
            if (this.#closing || this.#closed || signal.aborted)
                return fail("closed");
            return this.#upstream.execute(call, auth, { signal });
        });
        this.#executions.add(owned);
        void owned.then(() => this.#executions.delete(owned), () => this.#executions.delete(owned));
        return owned;
    }
    close(): Promise<void> {
        if (this.#closeFlight)
            return this.#closeFlight;
        this.#closing = true;
        this.#abort.abort();
        return this.#closeFlight = this.#drain();
    }
    async #drain(): Promise<void> {
        const service = this.#service?.close() ?? Promise.resolve();
        const outcomes = await Promise.allSettled([service, ...this.#executions]);
        if (outcomes[0]?.status !== "fulfilled")
            fail("drain_failed");
        // Rejected execute outcomes are settled requests, not outstanding work. Gateway owns their unknown receipts.
        if (this.#dispose) {
            try {
                await this.#dispose();
            }
            catch {
                return fail("dispose_failed");
            }
        }
        this.#closed = true;
    }
}
