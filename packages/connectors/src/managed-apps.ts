import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkManifest, manifestHash, type CapabilityGateway, type ToolManifest, type WriterLease } from "@dexter/gateway";
import { composioUserId, isMetaSlug, type ComposioBotSession, type ComposioSessionSource } from "./composio.js";
export type ManagedAppsErrorCode = "invalid_input" | "conflict" | "unavailable" | "closed" | "forbidden";
export class ManagedAppsError extends Error {
    constructor(readonly code: ManagedAppsErrorCode) { super(`managed apps: ${code}`); this.name = "ManagedAppsError"; }
}
export interface ManagedAppsIdentity {
    installationId: string;
    ownerId: string;
}
export interface ManagedAccountReceipt extends ManagedAppsIdentity {
    profileId: string;
    toolkit: string;
    userId: string;
    accountId: string;
    version: string;
    status: "active" | "revoked";
}
export interface ManagedProvisionRequest extends ManagedAppsIdentity {
    operationId: string;
    profileId: string;
    toolkit: string;
    userId: string;
    version: string;
    catalogRevision: number;
}
/** Trusted host boundary, not an HTTP contract. Provider owns OAuth/project auth privately. lookup is read-only. */
export interface ManagedAppsProvider {
    catalog(identity: Readonly<ManagedAppsIdentity>, signal: AbortSignal): Promise<readonly ToolManifest[]>;
    provision(request: Readonly<ManagedProvisionRequest>, signal: AbortSignal): Promise<ManagedAccountReceipt>;
    lookup(request: Readonly<ManagedProvisionRequest>, signal: AbortSignal): Promise<ManagedAccountReceipt | null>;
    account(receipt: Readonly<ManagedAccountReceipt>, signal: AbortSignal): Promise<ManagedAccountReceipt>;
}
export interface ManagedAppsHost {
    readonly hostId: string;
    readonly ownerId: string;
    readonly databasePath: string;
    withWriterLease: WriterLease;
    listBots(): Array<{
        id: string;
        profileId: string;
    }>;
    getBot(id: string): {
        id: string;
        profileId: string;
    };
    setGrant(input: unknown): unknown;
}
export interface ManagedAppsOptions {
    store: ManagedAppsHost;
    gateway: CapabilityGateway;
    provider: ManagedAppsProvider;
    /** Fixed broker reference and upstream host from trusted host configuration; never accepted from provider/engine. */
    credentialRef: string;
    upstreamHost: string;
    /** Host broker's known values. Metadata containing one is refused rather than persisted. */
    secretValues?: () => readonly string[];
}
export interface ManagedAppOperation {
    operationId: string;
    profileId: string;
    toolkit: string;
    version: string;
    state: "inflight" | "unknown" | "confirmed" | "revoked";
    connectionId: string | null;
}
type Row = Record<string, unknown>;
const fail = (code: ManagedAppsErrorCode): never => { throw new ManagedAppsError(code); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VERSION = /^\d{8}_\d{2}$/;
const KIT = /^[a-z][a-z0-9_-]{0,63}$/;
const object = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : fail("invalid_input");
const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const text = (v: unknown, pattern = ID): string => typeof v === "string" && pattern.test(v) ? v : fail("invalid_input");
/** Owner-only administration. Never publish this object/methods as engine tools. No credential values in this DB. */
export class ManagedAppsService implements ComposioSessionSource {
    readonly #store: ManagedAppsHost;
    readonly #gateway: CapabilityGateway;
    readonly #provider: ManagedAppsProvider;
    readonly #credentialRef: string;
    readonly #host: string;
    readonly #secrets: () => readonly string[];
    readonly #db: DatabaseSync;
    readonly #path: string;
    readonly #abort = new AbortController();
    readonly #work = new Set<Promise<unknown>>();
    readonly #reconciles = new Map<string, Promise<ManagedAppOperation>>();
    #closed = false;
    #closing = false;
    #closeFlight: Promise<void> | null = null;
    constructor(options: ManagedAppsOptions) {
        this.#store = options.store;
        this.#gateway = options.gateway;
        this.#provider = options.provider;
        if (options.gateway.registry.installationId !== options.store.hostId || options.gateway.registry.ownerId !== options.store.ownerId || dirname(options.gateway.registry.databasePath) !== dirname(options.store.databasePath))
            fail("conflict");
        this.#credentialRef = text(options.credentialRef);
        this.#host = text(options.upstreamHost, /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
        this.#secrets = options.secretValues ?? (() => []);
        this.#path = join(dirname(options.store.databasePath), "managed-apps.sqlite");
        this.#db = this.#store.withWriterLease(() => {
            this.#files();
            const db = new DatabaseSync(this.#path);
            try {
                chmodSync(this.#path, 0o600);
                db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
                db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS catalog(name TEXT PRIMARY KEY,manifest TEXT NOT NULL,hash TEXT NOT NULL,approved INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS catalog_revisions(revision INTEGER PRIMARY KEY,manifests TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,pin TEXT NOT NULL,request TEXT NOT NULL,label TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,connection_id TEXT,generation INTEGER NOT NULL);");
                const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row | undefined)?.value;
                if (get("owner") === undefined) {
                    const put = db.prepare("INSERT INTO meta VALUES (?,?)");
                    for (const [k, v] of [["schema", "1"], ["installation", this.#store.hostId], ["owner", this.#store.ownerId], ["revision", "0"], ["configuration", fingerprint({ host: this.#host, credentialRef: this.#credentialRef })]])
                        put.run(k!, v!);
                }
                if (get("configuration") !== fingerprint({ host: this.#host, credentialRef: this.#credentialRef }) || get("schema") !== "1" || get("owner") !== this.#store.ownerId || get("installation") !== this.#store.hostId)
                    fail("conflict");
                db.prepare("UPDATE operations SET state='unknown' WHERE state='inflight'").run();
                db.exec("COMMIT");
                this.#files();
                return db;
            }
            catch (e) {
                try {
                    db.exec("ROLLBACK");
                }
                catch { }
                db.close();
                throw e;
            }
        });
    }
    toJSON() { return { kind: "host_managed_apps", ...this.#identity() }; }
    #identity(): ManagedAppsIdentity { return { installationId: this.#store.hostId, ownerId: this.#store.ownerId }; }
    #files() {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            let stat;
            try {
                stat = lstatSync(this.#path + suffix);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT")
                    continue;
                throw e;
            }
            if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))
                fail("conflict");
            chmodSync(this.#path + suffix, 0o600);
        }
    }
    #write<T>(fn: () => T): T {
        if (this.#closed)
            return fail("closed");
        return this.#store.withWriterLease(() => {
            this.#files();
            this.#db.exec("BEGIN IMMEDIATE");
            try {
                const result = fn();
                this.#db.exec("COMMIT");
                return result;
            }
            catch (e) {
                this.#db.exec("ROLLBACK");
                throw e;
            }
        });
    }
    #safe(value: unknown): unknown {
        let serialized: string;
        try {
            const encoded = JSON.stringify(value);
            if (encoded === undefined)
                return fail("invalid_input");
            serialized = encoded;
        }
        catch {
            return fail("invalid_input");
        }
        if (serialized.includes(this.#credentialRef))
            fail("invalid_input");
        if (serialized.length > 262144)
            fail("invalid_input");
        let secrets: readonly string[];
        try {
            secrets = this.#secrets();
        }
        catch {
            return fail("unavailable");
        }
        const checkStrings = (value: unknown): void => {
            if (typeof value === "string") {
                if (secrets.some(secret => secret.length > 0 && value.includes(secret)))
                    fail("invalid_input");
            }
            else if (value !== null && typeof value === "object") {
                for (const [key, child] of Object.entries(value)) {
                    checkStrings(key);
                    checkStrings(child);
                }
            }
        };
        const snapshot: unknown = JSON.parse(serialized);
        checkStrings(snapshot);
        return snapshot;
    }
    #row(operationId: string): Row | undefined { return this.#db.prepare("SELECT * FROM operations WHERE id=?").get(operationId) as Row | undefined; }
    #view(row: Row): ManagedAppOperation {
        const request = JSON.parse(row.request as string) as ManagedProvisionRequest;
        return { operationId: row.id as string, profileId: request.profileId, toolkit: request.toolkit, version: request.version, state: row.state as ManagedAppOperation["state"], connectionId: row.connection_id as string | null };
    }
    operation(operationId: string): ManagedAppOperation | null {
        if (this.#closed)
            fail("closed");
        const row = this.#row(text(operationId));
        return row ? this.#view(row) : null;
    }
    catalog(): {
        revision: number;
        tools: Array<{
            manifest: ToolManifest;
            approved: boolean;
        }>;
    } {
        if (this.#closed)
            fail("closed");
        const revision = Number((this.#db.prepare("SELECT value FROM meta WHERE key='revision'").get() as Row).value);
        return { revision, tools: (this.#db.prepare("SELECT * FROM catalog ORDER BY name").all() as Row[]).map(r => ({ manifest: JSON.parse(r.manifest as string) as ToolManifest, approved: r.approved === 1 })) };
    }
    catalogRevision(revision: number): readonly ToolManifest[] | null {
        if (this.#closed)
            fail("closed");
        if (!Number.isSafeInteger(revision) || revision < 1)
            fail("invalid_input");
        const row = this.#db.prepare("SELECT manifests FROM catalog_revisions WHERE revision=?").get(revision) as Row | undefined;
        return row ? JSON.parse(row.manifests as string) as ToolManifest[] : null;
    }
    #track<T>(fn: () => Promise<T>): Promise<T> {
        if (this.#closed || this.#closing)
            return Promise.reject(new ManagedAppsError("closed"));
        const p = Promise.resolve().then(() => { this.#beforeProvider(); return fn(); }).catch((error: unknown) => {
            if (error instanceof ManagedAppsError || (error && typeof error === "object" && "code" in error && error.code === "host_locked"))
                throw error;
            return fail("unavailable");
        });
        this.#work.add(p);
        void p.then(() => this.#work.delete(p), () => this.#work.delete(p));
        return p;
    }
    #beforeProvider(): void { if (this.#closed || this.#closing || this.#abort.signal.aborted)
        fail("closed"); }
    #providerFailure(): never { return fail(this.#abort.signal.aborted ? "closed" : "unavailable"); }
    syncCatalog(expectedRevision: number): Promise<number> {
        return this.#track(async () => {
            let raw: readonly ToolManifest[];
            try {
                this.#beforeProvider();
                raw = await this.#provider.catalog(Object.freeze(this.#identity()), this.#abort.signal);
            }
            catch {
                return this.#providerFailure();
            }
            if (this.#abort.signal.aborted)
                fail("closed");
            const snap = this.#safe(raw);
            if (!Array.isArray(snap) || snap.length > 128)
                fail("invalid_input");
            const tools = (snap as unknown[]).map(v => {
                const m = checkManifest(v);
                if (!VERSION.test(m.version) || isMetaSlug(m.upstreamSlug) || m.upstreamHost !== this.#host)
                    fail("invalid_input");
                return m;
            });
            if (new Set(tools.map(t => t.name)).size !== tools.length)
                fail("invalid_input");
            const retired = this.#write(() => {
                const old = this.catalog();
                if (old.revision !== expectedRevision)
                    fail("conflict");
                const invalid = old.tools.filter(o => o.approved && !tools.some(m => m.name === o.manifest.name && manifestHash(m) === manifestHash(o.manifest))).map(o => o.manifest.name);
                this.#db.exec("DELETE FROM catalog");
                const put = this.#db.prepare("INSERT INTO catalog VALUES (?,?,?,?)");
                for (const m of tools)
                    put.run(m.name, JSON.stringify(m), manifestHash(m), old.tools.some(o => o.approved && manifestHash(o.manifest) === manifestHash(m)) ? 1 : 0);
                this.#db.prepare("INSERT INTO catalog_revisions VALUES (?,?)").run(expectedRevision + 1, JSON.stringify(tools));
                this.#db.prepare("UPDATE meta SET value=? WHERE key='revision'").run(String(expectedRevision + 1));
                return invalid;
            });
            for (const name of retired)
                this.#gateway.retireTool(name);
            return expectedRevision + 1;
        });
    }
    /** Explicit host review, never approval inferred from the provider catalog. */
    approveTools(revision: number, names: readonly string[]): void {
        const current = this.#write(() => {
            const c = this.catalog();
            if (c.revision !== revision || !Array.isArray(names) || names.length > 128 || new Set(names).size !== names.length)
                fail("conflict");
            return names.map(n => c.tools.find(t => t.manifest.name === n)?.manifest ?? fail("invalid_input"));
        });
        for (const tool of current)
            this.#gateway.registerTool(tool);
        this.#write(() => {
            if (this.catalog().revision !== revision)
                fail("conflict");
            for (const tool of current)
                this.#db.prepare("UPDATE catalog SET approved=1 WHERE name=? AND hash=?").run(tool.name, manifestHash(tool));
        });
    }
    #request(operationId: string, input: {
        profileId: string;
        toolkit: string;
        version: string;
    }, requireReviewed = true): ManagedProvisionRequest {
        const profileId = text(input.profileId), toolkit = text(input.toolkit, KIT), version = text(input.version, VERSION);
        if (!this.#store.listBots().some(b => b.profileId === profileId))
            fail("forbidden");
        if (requireReviewed && !this.catalog().tools.some(t => t.approved && t.manifest.toolkit === toolkit && t.manifest.version === version))
            fail("forbidden");
        return { ...this.#identity(), operationId: text(operationId), profileId, toolkit, version, catalogRevision: this.catalog().revision, userId: composioUserId(this.#store.hostId, this.#store.ownerId, profileId) };
    }
    #receipt(raw: unknown, req: ManagedProvisionRequest): ManagedAccountReceipt {
        const r = object(this.#safe(raw));
        if (Object.keys(r).sort().join() !== "accountId,installationId,ownerId,profileId,status,toolkit,userId,version")
            fail("invalid_input");
        for (const key of ["installationId", "ownerId", "profileId", "toolkit", "userId", "version"] as const)
            if (r[key] !== req[key])
                fail("conflict");
        if (r.status !== "active" && r.status !== "revoked")
            fail("invalid_input");
        text(r.accountId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
        return { installationId: req.installationId, ownerId: req.ownerId, profileId: req.profileId, toolkit: req.toolkit, userId: req.userId, accountId: r.accountId as string, version: req.version, status: r.status as ManagedAccountReceipt["status"] };
    }
    provision(operationId: string, input: {
        profileId: string;
        toolkit: string;
        version: string;
        label: string;
    }): Promise<ManagedAppOperation> {
        if (this.#closed || this.#closing)
            return Promise.reject(new ManagedAppsError("closed"));
        const previous = this.#write(() => this.#row(text(operationId)));
        const req = this.#request(operationId, input, previous === undefined);
        if (previous)
            req.catalogRevision = (JSON.parse(previous.request as string) as ManagedProvisionRequest).catalogRevision;
        const label = text(input.label, /^[^\u0000-\u001f]{1,120}$/);
        this.#safe({ req, label });
        const pin = fingerprint({ req, label });
        const start = this.#write(() => {
            const existing = this.#row(req.operationId);
            if (existing) {
                if (existing.pin !== pin)
                    fail("conflict");
                return false;
            }
            this.#db.prepare("INSERT INTO operations VALUES (?,?,?,?,'inflight',NULL,NULL,1)").run(req.operationId, pin, JSON.stringify(req), label);
            return true;
        });
        if (!start)
            return Promise.resolve(this.operation(operationId)!);
        return this.#track(async () => {
            let receipt: ManagedAccountReceipt;
            try {
                this.#beforeProvider();
                receipt = this.#receipt(await this.#provider.provision(Object.freeze(req), this.#abort.signal), req);
            }
            catch {
                this.#write(() => this.#db.prepare("UPDATE operations SET state='unknown' WHERE id=? AND state='inflight'").run(operationId));
                return this.operation(operationId)!;
            }
            try {
                return this.#register(operationId, receipt, 1);
            }
            finally {
                this.#write(() => this.#db.prepare("UPDATE operations SET state='unknown' WHERE id=? AND state='inflight'").run(operationId));
            }
        });
    }
    #catalogUsable(req: ManagedProvisionRequest): boolean {
        const original = this.catalogRevision(req.catalogRevision);
        if (!original)
            return false;
        const current = this.catalog().tools.filter(t => t.approved && t.manifest.toolkit === req.toolkit && t.manifest.version === req.version);
        return current.length > 0 && current.every(t => original.some(m => m.name === t.manifest.name && manifestHash(m) === manifestHash(t.manifest)));
    }
    #register(operationId: string, receipt: ManagedAccountReceipt, generation: number): ManagedAppOperation {
        const row = this.#write(() => {
            const latest = this.#row(operationId) ?? fail("conflict");
            if (latest.generation !== generation || latest.state === "revoked" || this.#abort.signal.aborted)
                fail("conflict");
            if (latest.state === "confirmed") {
                if (latest.receipt !== JSON.stringify(receipt))
                    fail("conflict");
                return latest;
            }
            if (latest.state !== "unknown" && latest.state !== "inflight")
                fail("conflict");
            const req = JSON.parse(latest.request as string) as ManagedProvisionRequest;
            if (!this.#catalogUsable(req))
                fail("conflict");
            return latest;
        });
        if (row.state === "confirmed")
            return this.#view(row);
        if (receipt.status !== "active") {
            this.revoke(operationId);
            return this.operation(operationId)!;
        }
        const candidates = this.#gateway.registry.listConnections(receipt.profileId).filter(c => c.status === "active" && c.toolkit === receipt.toolkit && c.upstreamAccountRef === receipt.accountId && c.credentialRef === this.#credentialRef && c.allowedHosts.length === 1 && c.allowedHosts[0] === this.#host);
        // An unreferenced connection can be the same confirmation's cross-DB commit gap.
        // An upstream account is not an operation identity: other operations keep independent grants and revocation.
        const existing = this.#write(() => candidates.find(c => !this.#db.prepare("SELECT 1 FROM operations WHERE connection_id=? AND id<>? LIMIT 1").get(c.id, operationId)));
        const connection = existing ?? this.#gateway.connectAccount({ profileId: receipt.profileId, toolkit: receipt.toolkit, label: row.label as string, upstreamAccountRef: receipt.accountId, credentialRef: this.#credentialRef, allowedHosts: [this.#host] });
        try {
            const committed = this.#write(() => {
                const latest = this.#row(operationId) ?? fail("conflict");
                if (latest.generation !== generation || this.#abort.signal.aborted)
                    fail("conflict");
                if (latest.state === "confirmed") {
                    if (latest.receipt !== JSON.stringify(receipt))
                        fail("conflict");
                    return latest;
                }
                if ((latest.state !== "unknown" && latest.state !== "inflight") || !this.#catalogUsable(JSON.parse(latest.request as string) as ManagedProvisionRequest))
                    fail("conflict");
                if (this.#db.prepare("SELECT 1 FROM operations WHERE connection_id=? AND id<>? LIMIT 1").get(connection.id, operationId))
                    fail("conflict");
                const result = this.#db.prepare("UPDATE operations SET state='confirmed',receipt=?,connection_id=? WHERE id=? AND generation=? AND state IN ('unknown','inflight')").run(JSON.stringify(receipt), connection.id, operationId, generation);
                if (result.changes !== 1)
                    fail("conflict");
                return this.#row(operationId)!;
            });
            if (!existing && committed.connection_id !== connection.id)
                this.#gateway.revokeConnection(connection.id);
            return this.#view(committed);
        }
        catch (error) {
            // Best effort under the same canonical writer. Writer loss still requires owner recovery of the cross-DB gap.
            if (!existing)
                this.#gateway.revokeConnection(connection.id);
            throw error;
        }
    }
    /** Read-only provider outcome lookup. Missing/ambiguous outcomes remain unknown and never invoke provision again. */
    reconcile(operationId: string): Promise<ManagedAppOperation> {
        const id = text(operationId);
        const active = this.#reconciles.get(id);
        if (active)
            return active;
        const flight = this.#track(async () => {
            const row = this.#write(() => this.#row(text(operationId)) ?? fail("invalid_input"));
            if (row.state !== "unknown")
                return this.#view(row);
            const req = JSON.parse(row.request as string) as ManagedProvisionRequest;
            let receipt: ManagedAccountReceipt | null;
            try {
                this.#beforeProvider();
                const raw = await this.#provider.lookup(Object.freeze(req), this.#abort.signal);
                receipt = raw === null ? null : this.#receipt(raw, req);
            }
            catch {
                return this.#view(row);
            }
            if (!receipt)
                return this.operation(operationId)!;
            return this.#register(operationId, receipt, row.generation as number);
        });
        this.#reconciles.set(id, flight);
        void flight.then(() => { if (this.#reconciles.get(id) === flight)
            this.#reconciles.delete(id); }, () => { if (this.#reconciles.get(id) === flight)
            this.#reconciles.delete(id); });
        return flight;
    }
    revoke(operationId: string): void {
        const connection = this.#write(() => { const row = this.#row(text(operationId)) ?? fail("invalid_input"); this.#db.prepare("UPDATE operations SET state='revoked',generation=generation+1 WHERE id=?").run(operationId); return row.connection_id as string | null; });
        if (connection)
            this.#gateway.revokeConnection(connection);
    }
    refreshAccount(operationId: string): Promise<ManagedAppOperation> {
        return this.#track(async () => {
            const row = this.#write(() => this.#row(text(operationId)) ?? fail("invalid_input"));
            if (row.state !== "confirmed")
                fail("conflict");
            const old = JSON.parse(row.receipt as string) as ManagedAccountReceipt, req = JSON.parse(row.request as string) as ManagedProvisionRequest;
            let receipt: ManagedAccountReceipt;
            try {
                this.#beforeProvider();
                receipt = this.#receipt(await this.#provider.account(Object.freeze(old), this.#abort.signal), req);
            }
            catch {
                return this.#providerFailure();
            }
            if (this.#abort.signal.aborted)
                fail("closed");
            this.#write(() => {
                if (this.#row(operationId)!.generation !== row.generation)
                    fail("conflict");
            });
            if (fingerprint(receipt) !== fingerprint(old))
                this.revoke(operationId);
            return this.operation(operationId)!;
        });
    }
    grant(input: {
        operationId: string;
        botId: string;
        tool: string;
        policy: "allow" | "ask" | "deny";
        expiresAt?: number;
    }): void {
        const op = this.#write(() => this.#row(text(input.operationId)) ?? fail("invalid_input"));
        if (op.state !== "confirmed" || !op.connection_id)
            fail("forbidden");
        const req = JSON.parse(op.request as string) as ManagedProvisionRequest, bot = this.#store.getBot(input.botId);
        const tool = this.catalog().tools.find(t => t.approved && t.manifest.name === input.tool && t.manifest.toolkit === req.toolkit && t.manifest.version === req.version);
        const registered = tool ? this.#gateway.registry.getTool(tool.manifest.name) : null;
        if (!tool || registered?.status !== "active" || registered.manifestHash !== manifestHash(tool.manifest) || bot.profileId !== req.profileId || this.#gateway.registry.getConnection(op.connection_id as string)?.status !== "active")
            fail("forbidden");
        this.#store.setGrant({ botId: bot.id, tool: input.tool, destination: op.connection_id, policy: input.policy, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) });
    }
    /** Dynamic trusted binding source for ComposioToolAdapter. Neither public catalog nor engines receive account refs. */
    find(scope: Parameters<ComposioSessionSource["find"]>[0], connectionId: string): ComposioBotSession | null {
        if (this.#closed || scope.installationId !== this.#store.hostId || scope.ownerId !== this.#store.ownerId)
            return null;
        let bot: {
            id: string;
            profileId: string;
        };
        try {
            bot = this.#store.getBot(scope.botId);
        }
        catch {
            return null;
        }
        if (bot.profileId !== scope.profileId)
            return null;
        const row = this.#db.prepare("SELECT * FROM operations WHERE connection_id=? AND state='confirmed' ORDER BY id LIMIT 1").get(connectionId) as Row | undefined;
        if (!row)
            return null;
        const receipt = JSON.parse(row.receipt as string) as ManagedAccountReceipt;
        const connection = this.#gateway.registry.getConnection(connectionId);
        if (!connection || connection.status !== "active" || connection.profileId !== scope.profileId || receipt.profileId !== scope.profileId)
            return null;
        const tools = this.catalog().tools.filter(t => t.approved && t.manifest.toolkit === receipt.toolkit && t.manifest.version === receipt.version && this.#gateway.registry.getTool(t.manifest.name)?.manifestHash === manifestHash(t.manifest)).map(t => ({ slug: t.manifest.upstreamSlug, version: t.manifest.version }));
        return { ...scope, connectionId, toolkit: receipt.toolkit, upstreamUserId: receipt.userId, connectedAccountId: receipt.accountId, tools };
    }
    close(): Promise<void> {
        return this.#closeFlight ??= this.#finishClose();
    }
    async #finishClose(): Promise<void> {
        if (this.#closed)
            return;
        this.#closing = true;
        this.#abort.abort();
        await Promise.allSettled([...this.#work]);
        this.#write(() => this.#db.prepare("UPDATE operations SET state='unknown' WHERE state='inflight'").run());
        this.#store.withWriterLease(() => this.#db.close());
        this.#closed = true;
    }
}
