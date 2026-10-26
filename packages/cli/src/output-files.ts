import { createHash } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  OUTPUT_FILES_CONTRACT_VERSION, OUTPUT_FILES_LIMITS, OutputNamespaceRefSchema, OutputRelativePathSchema, SetOutputDestinationSchema,
  type OutputDestinationReceipt, type OutputEntries, type OutputEntry, type OutputFilesStatus, type OutputItem, type OutputLocation,
  type OutputLocations, type OutputNamespace, type OutputNamespaces,
} from "@dexter/contracts";
import { isWellFormedText } from "./text-input.js";

/**
 * Output folders of this base (host). One ledger per data directory (`output-files.sqlite`, local schema "1", created on
 * demand): generations of root locations. The current generation receives NEW files only; older generations are never
 * moved, rewritten or deleted and stay listable/exportable by the owner.
 *
 * Layouts: `v1` = general `<root>` with `Bots/<botId>` and `Times/<teamId>`; `legacy` = implicit generation 1 of every
 * base, the host data directory with `bot-files/<botId>` (unchanged from before) and `team-files/<teamId>` (team turns no
 * longer touch a member's private folder); it has no general listing because the data directory holds internal stores.
 *
 * Bot tools reach exactly one namespace resolved by the trusted host from the turn (never an argument). A turn stays on the
 * generation of its first file operation. Owner reads are no-follow, bounded and never feed any bot context.
 */
export const OUTPUT_FILES_DATABASE_FILE = "output-files.sqlite";
export const OUTPUT_FILES_SCHEMA_VERSION = "1";
export const OUTPUT_FILES_DEFAULT_DIRECTORY = "outputs";
export const OUTPUT_FILES_LEGACY_BOTS = "bot-files";
export const OUTPUT_FILES_LEGACY_TEAMS = "team-files";
const BOTS = "Bots", TEAMS = "Times";
const folderOf = (layout: OutputLocation["layout"], kind: "bot" | "team"): string =>
  layout === "v1" ? (kind === "bot" ? BOTS : TEAMS) : (kind === "bot" ? OUTPUT_FILES_LEGACY_BOTS : OUTPUT_FILES_LEGACY_TEAMS);
const TOOL_FILE_BYTES = 65_536;
const UNBOUND = "unbound";
const NAMESPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Same secret-name screen as the file tools: never listed by name, never exported. */
export const OUTPUT_SECRET_NAME = /^(?:\.env(?:\.|$)|\.ssh$|\.aws$|\.gnupg$|\.config$|\.git$|\.npmrc$|\.netrc$|\.git-credentials$|id_(?:rsa|ed25519|ecdsa)(?:\.|$))|(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|auth|keychain)(?:[._-]|$)|\.(?:pem|p12|pfx|key)$/i;
export const OUTPUT_INTERNAL_NAME = /^\.dexter-write-/;
const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 1), current_generation INTEGER NOT NULL CHECK(current_generation >= 1),
  updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE locations(generation INTEGER PRIMARY KEY CHECK(generation >= 1 AND generation <= ${OUTPUT_FILES_LIMITS.ledgerGenerations}),
  kind TEXT NOT NULL CHECK(kind IN ('host_data_legacy','host_data_default','owner_path')), layout TEXT NOT NULL CHECK(layout IN ('v1','legacy')),
  path TEXT NOT NULL, device TEXT, inode TEXT, created_at INTEGER NOT NULL, retired_at INTEGER, request_id TEXT) STRICT;
CREATE TABLE receipts(client_request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
`;
const MEDIA: Readonly<Record<string, string>> = Object.freeze({
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json", ".xml": "application/xml",
  ".html": "text/html", ".htm": "text/html", ".yaml": "application/yaml", ".yml": "application/yaml", ".log": "text/plain",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".svg": "image/svg+xml", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".key": "application/vnd.apple.keynote", ".pages": "application/vnd.apple.pages", ".numbers": "application/vnd.apple.numbers",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".zip": "application/zip",
});
export function outputMediaType(name: string): string { return MEDIA[extname(name).toLowerCase()] ?? "application/octet-stream"; }

export type OutputFilesErrorCode = "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable";
/** Fixed codes only; messages never carry paths, names or content. */
export class OutputFilesError extends Error {
  constructor(readonly code: OutputFilesErrorCode, readonly reason: string) { super(`output files: ${code}`); this.name = "OutputFilesError"; }
}
const fail = (code: OutputFilesErrorCode, reason: string = code): never => { throw new OutputFilesError(code, reason); };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const optionalLstat = (path: string): Stats | null => {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw error; }
};
const fileIdentity = (stat: Stats): string => sha256(JSON.stringify({ device: String(stat.dev), inode: String(stat.ino), size: String(stat.size),
  modified: String(stat.mtimeMs), changed: String(stat.ctimeMs) }));
const sameDirectory = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

interface LocationRecord { generation: number; kind: OutputLocation["kind"]; layout: OutputLocation["layout"]; path: string;
  device: string | null; inode: string | null; createdAt: number | null; retiredAt: number | null }
type Row = Record<string, unknown>;
const recordOf = (row: Row): LocationRecord => ({ generation: Number(row.generation), kind: row.kind as LocationRecord["kind"], layout: row.layout as LocationRecord["layout"],
  path: String(row.path), device: row.device === null ? null : String(row.device), inode: row.inode === null ? null : String(row.inode),
  createdAt: Number(row.created_at), retiredAt: row.retired_at === null ? null : Number(row.retired_at) });

/** One resolved bot/team namespace for the file tools (trusted host composition only). */
export interface OutputToolNamespace {
  readonly generation: number;
  readonly kind: "bot" | "team";
  readonly id: string;
  /** Location root (exact real path) and its directory identity; every tool operation re-checks both. */
  readonly root: string;
  readonly rootIdentity: { device: string; inode: string } | null;
  /** Parent of the namespace directory (`<root>/Bots`, `<root>/Times`, `<dataDir>/bot-files`, `<dataDir>/team-files`). */
  readonly base: string;
  readonly path: string;
  /** Display only, relative to the root: `Bots/<id>`, `Times/<id>`, `bot-files/<id>` or `team-files/<id>`. */
  readonly relative: string;
  readonly layout: OutputLocation["layout"];
}
export interface OutputToolTarget { kind: "bot" | "team"; id: string; turnId: string | null }
export interface OutputFilesOptions {
  dataDir: string;
  /**
   * Canonical installation/owner (the host always passes it). Omitted only by in-process fixtures: such an instance
   * accepts the existing ledger and records "unbound" if it creates one; the host binds an unbound ledger on first open.
   */
  identity?: () => { hostId: string; ownerId: string };
  bots?: () => ReadonlyArray<{ id: string; name: string }>;
  teams?: () => ReadonlyArray<{ id: string; name: string }>;
  /** Canonical writer admission: `assert` inside existing fences (tools), `lease` for owner mutations. */
  writer?: { assert(): void; lease<T>(operation: () => T): T };
  /** True only while the host composes the paired app-client channel that serves these routes; absent = owner loopback only. */
  pairedBrowsing?: () => boolean;
  now?: () => number;
}
export interface OutputContentChunk { bytes: Buffer; mediaType: string; name: string; size: number; offset: number }
type Query = Record<string, string | undefined>;

export class OutputFilesService {
  readonly #dataDir: string;
  readonly #identity: () => { hostId: string; ownerId: string } | null;
  readonly #bots: NonNullable<OutputFilesOptions["bots"]>;
  readonly #teams: NonNullable<OutputFilesOptions["teams"]>;
  readonly #writer: NonNullable<OutputFilesOptions["writer"]>;
  readonly #paired: () => boolean;
  readonly #now: () => number;
  readonly #turns = new Map<string, number>();
  #db: DatabaseSync | null = null;
  #closed = false;

  /** Pure construction: no file, directory or database is created until a destination change or namespace creation. */
  constructor(options: OutputFilesOptions) {
    if (!options || typeof options.dataDir !== "string" || !isAbsolute(options.dataDir) || !isWellFormedText(options.dataDir)
      || /[\u0000-\u001f\u007f]/.test(options.dataDir) || (options.identity !== undefined && typeof options.identity !== "function")
      || (options.pairedBrowsing !== undefined && typeof options.pairedBrowsing !== "function")) fail("invalid_input");
    this.#dataDir = resolve(options.dataDir);
    this.#identity = options.identity ?? (() => null);
    const paired = options.pairedBrowsing;
    this.#paired = paired ? () => paired() === true : () => false;
    this.#bots = options.bots ?? (() => []);
    this.#teams = options.teams ?? (() => []);
    this.#writer = options.writer ?? { assert: () => {}, lease: operation => operation() };
    this.#now = options.now ?? Date.now;
  }

  // ---- ledger -------------------------------------------------------------------------------------

  #hostId(): string { return this.#identity()?.hostId ?? UNBOUND; }
  #data(): string {
    if (this.#closed) fail("unavailable", "closed");
    const data = realpathSync(this.#dataDir), stat = lstatSync(data);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unavailable", "data_directory");
    return data;
  }
  #databasePath(): string { return join(this.#data(), OUTPUT_FILES_DATABASE_FILE); }
  /** Existing ledger or null (never creates). Refuses another installation's file or a newer schema untouched. */
  #open(): DatabaseSync | null {
    if (this.#db) return this.#db;
    const path = this.#databasePath(), stat = optionalLstat(path);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("unavailable", "ledger_unsafe");
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row | undefined)?.value;
      const identity = this.#identity();
      if (get("schema") !== OUTPUT_FILES_SCHEMA_VERSION) fail("unavailable", "ledger_schema");
      if (identity && get("installation") === UNBOUND && get("owner") === UNBOUND) {
        db.prepare("UPDATE meta SET value=? WHERE key='installation' AND value=?").run(identity.hostId, UNBOUND);
        db.prepare("UPDATE meta SET value=? WHERE key='owner' AND value=?").run(identity.ownerId, UNBOUND);
      } else if (identity && (get("installation") !== identity.hostId || get("owner") !== identity.ownerId)) fail("conflict", "ledger_identity");
    } catch (error) { db.close(); throw error; }
    this.#db = db;
    return db;
  }
  /** Implicit first generation of every base: the paths in use before output folders existed. Nothing is moved. */
  #initial(): LocationRecord {
    const data = this.#data(), stat = lstatSync(data);
    return { generation: 1, kind: "host_data_legacy", layout: "legacy", path: data, device: String(stat.dev), inode: String(stat.ino), createdAt: null, retiredAt: null };
  }
  #snapshot(): { persisted: boolean; revision: number; current: number; records: LocationRecord[] } {
    const db = this.#open();
    if (!db) { const initial = this.#initial(); return { persisted: false, revision: 1, current: 1, records: [initial] }; }
    const state = db.prepare("SELECT revision, current_generation FROM state WHERE id=1").get() as Row | undefined;
    if (!state) fail("unavailable", "ledger_state");
    const records = (db.prepare("SELECT * FROM locations ORDER BY generation").all() as Row[]).map(recordOf);
    const current = Number(state!.current_generation);
    if (!records.some(record => record.generation === current)) fail("unavailable", "ledger_state");
    return { persisted: true, revision: Number(state!.revision), current, records };
  }
  /** Creates the ledger with the first generation (the same decision readers saw), once. */
  #ensure(): DatabaseSync {
    const existing = this.#open();
    if (existing) return existing;
    const path = this.#databasePath(), initial = this.#initial(), identity = this.#identity(), now = this.#now();
    const hostId = identity?.hostId ?? UNBOUND, ownerId = identity?.ownerId ?? UNBOUND;
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
      if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
        db.exec(SCHEMA);
        const put = db.prepare("INSERT INTO meta VALUES (?,?)");
        for (const [key, value] of [["schema", OUTPUT_FILES_SCHEMA_VERSION], ["installation", hostId], ["owner", ownerId]] as const) put.run(key, value);
        db.prepare("INSERT INTO state VALUES (1,1,1,?)").run(now);
        db.prepare("INSERT INTO locations VALUES (1,?,?,?,?,?,?,NULL,NULL)").run(initial.kind, initial.layout, initial.path, initial.device, initial.inode, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
      db.close(); throw error;
    }
    db.close();
    return this.#open()!;
  }
  #record(generation: number): LocationRecord {
    const record = this.#snapshot().records.find(item => item.generation === generation);
    return record ?? fail("not_found", "generation");
  }
  /** Live, closed availability of a root. Never trusts configuration alone. */
  #availability(record: LocationRecord): OutputLocation["availability"] {
    let stat: Stats | null;
    try { stat = optionalLstat(record.path); } catch { return "unreadable"; }
    if (!stat) return record.kind === "host_data_default" && record.device === null ? "not_created" : "missing";
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
    try { if (realpathSync(record.path) !== record.path) return "unsafe"; } catch { return "unreadable"; }
    if (record.device !== null && (String(stat.dev) !== record.device || String(stat.ino) !== record.inode)) return "replaced";
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "unsafe";
    if (record.kind === "owner_path" && (stat.mode & 0o022) !== 0) return "unsafe";
    try { accessSync(record.path, constants.R_OK | constants.X_OK); } catch { return "unreadable"; }
    return "available";
  }
  #view(record: LocationRecord, current: number): OutputLocation {
    return { generation: record.generation, kind: record.kind, layout: record.layout, path: record.path, current: record.generation === current,
      availability: this.#availability(record), namespaces: { general: record.layout === "v1", bots: true, teams: true },
      createdAt: record.createdAt, retiredAt: record.retiredAt };
  }

  // ---- tools --------------------------------------------------------------------------------------

  /**
   * The bot/team namespace of a turn in the generation it first used (or the current one). `create` persists the ledger
   * and creates the root of a default location; the namespace directories themselves are created by the tools.
   */
  toolNamespace(target: OutputToolTarget, create: boolean): OutputToolNamespace {
    this.#writer.assert();
    if ((target.kind !== "bot" && target.kind !== "team") || typeof target.id !== "string" || !NAMESPACE_ID.test(target.id)) fail("invalid_input");
    if (target.turnId !== null && (typeof target.turnId !== "string" || !REQUEST_ID.test(target.turnId))) fail("invalid_input");
    const snapshot = this.#snapshot();
    const generation = (target.turnId !== null ? this.#turns.get(target.turnId) : undefined) ?? snapshot.current;
    let record = snapshot.records.find(item => item.generation === generation) ?? fail("unavailable", "generation");
    if (create && !snapshot.persisted) { this.#ensure(); record = this.#record(generation); }
    if (create && record.kind === "host_data_default" && !optionalLstat(record.path)) {
      mkdirSync(record.path, { mode: 0o700 });
      const stat = lstatSync(record.path);
      this.#ensure().prepare("UPDATE locations SET device=?, inode=? WHERE generation=? AND device IS NULL").run(String(stat.dev), String(stat.ino), record.generation);
      record = this.#record(generation);
    }
    const availability = this.#availability(record);
    if (availability !== "available" && !(availability === "not_created" && !create)) fail("unavailable", availability);
    if (target.turnId !== null) {
      // A turn is never reparented to a newer destination; bounded memory, oldest first out.
      if (!this.#turns.has(target.turnId) && this.#turns.size >= 4096) this.#turns.delete(this.#turns.keys().next().value!);
      this.#turns.set(target.turnId, record.generation);
    }
    const base = join(record.path, folderOf(record.layout, target.kind)), relative = `${folderOf(record.layout, target.kind)}/${target.id}`;
    return Object.freeze({ generation: record.generation, kind: target.kind, id: target.id, root: record.path,
      rootIdentity: record.device === null ? null : Object.freeze({ device: record.device, inode: record.inode! }),
      base, path: join(base, target.id), relative, layout: record.layout });
  }
  /** Forgets a finished turn's generation binding (optional hygiene; bounded anyway). */
  releaseTurn(turnId: string): void { this.#turns.delete(turnId); }

  // ---- owner reads ----------------------------------------------------------------------------------

  status(): OutputFilesStatus {
    const snapshot = this.#snapshot(), current = snapshot.records.find(item => item.generation === snapshot.current)!, paired = this.#paired();
    return { version: OUTPUT_FILES_CONTRACT_VERSION, hostId: this.#hostId(), revision: snapshot.revision, persisted: snapshot.persisted,
      current: this.#view(current, snapshot.current),
      host: { platform: process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "other" },
      scope: { botFileTools: "own_bot_namespace", teamFileTools: "team_namespace_revalidated", groupTurns: "no_file_tools",
        terminalCwd: "output_namespace_not_os_sandbox", engineNativeWorkspace: "internal_not_outputs", contextDocuments: "separate_custody",
        sharing: "not_implemented", remoteBrowsing: paired ? "owner_loopback_and_paired_scoped" : "owner_loopback_only", relayedBrowsing: "not_relayed" },
      limits: { pageEntries: OUTPUT_FILES_LIMITS.pageEntries, scannedEntries: OUTPUT_FILES_LIMITS.scannedEntries, chunkBytes: OUTPUT_FILES_LIMITS.chunkBytes,
        exportBytes: OUTPUT_FILES_LIMITS.exportBytes, hashedBytes: OUTPUT_FILES_LIMITS.hashedBytes, toolFileBytes: TOOL_FILE_BYTES,
        pairedChunkBytes: paired ? OUTPUT_FILES_LIMITS.pairedChunkBytes : null } };
  }
  locations(): OutputLocations {
    const snapshot = this.#snapshot();
    return { version: OUTPUT_FILES_CONTRACT_VERSION, hostId: this.#hostId(), revision: snapshot.revision,
      items: snapshot.records.map(record => this.#view(record, snapshot.current)).reverse() };
  }
  #generationOf(query: Query): LocationRecord {
    const snapshot = this.#snapshot();
    if (query.generation === undefined) return snapshot.records.find(item => item.generation === snapshot.current)!;
    if (!/^[1-9][0-9]{0,2}$/.test(query.generation)) fail("invalid_input");
    return snapshot.records.find(item => item.generation === Number(query.generation)) ?? fail("not_found", "generation");
  }
  /** Readable root for owner reads: available, real and with the recorded identity. */
  #root(record: LocationRecord): Stats | null {
    const availability = this.#availability(record);
    if (availability === "not_created") return null;
    if (availability !== "available") fail("unavailable", availability);
    return lstatSync(record.path);
  }
  #namespaceDirectory(record: LocationRecord, ref: string): { kind: OutputNamespace["kind"]; id: string | null; path: string } {
    const parsed = OutputNamespaceRefSchema.safeParse(ref);
    if (!parsed.success) fail("invalid_input");
    if (ref === "general") {
      // The legacy root is the host data directory: its internal stores are never listed.
      if (record.layout !== "v1") fail("not_found", "general_absent_in_legacy");
      return { kind: "general", id: null, path: record.path };
    }
    const kind = ref.startsWith("bot:") ? "bot" as const : "team" as const, id = ref.slice(ref.indexOf(":") + 1);
    return { kind, id, path: join(record.path, folderOf(record.layout, kind), id) };
  }
  /** Walks `relative` beneath `directory` without following any link; every directory component must be real. */
  #walk(root: string, directory: string, relative: string): { path: string; stat: Stats | null } {
    const parsed = OutputRelativePathSchema.safeParse(relative);
    if (!parsed.success) fail("invalid_input");
    const inside = directory === root ? [] : directory.slice(root.length + 1).split(sep);
    const parts = [...inside, ...(relative === "." ? [] : relative.split("/"))];
    if (parts.some(part => Buffer.byteLength(part) > 255)) fail("invalid_input");
    if (relative !== "." && relative.split("/").some(part => OUTPUT_SECRET_NAME.test(part) || OUTPUT_INTERNAL_NAME.test(part))) fail("forbidden", "secret_like");
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      const stat = optionalLstat(current);
      if (!stat) return { path: join(directory, ...(relative === "." ? [] : relative.split("/"))), stat: null };
      if (stat.isSymbolicLink()) fail("forbidden", "symlink");
      if (index < parts.length - 1 && !stat.isDirectory()) fail("forbidden", "not_directory");
      if (stat.isDirectory() && realpathSync(current) !== current) fail("forbidden", "symlink");
    }
    return { path: current, stat: optionalLstat(current) };
  }
  #label(kind: "bot" | "team", id: string): string | null {
    const source = kind === "bot" ? this.#bots() : this.#teams(), match = source.find(item => item.id === id);
    if (!match || typeof match.name !== "string" || !isWellFormedText(match.name) || /[\u0000-\u001f\u007f-\u009f]/.test(match.name) || match.name.length < 1) return null;
    return match.name.length <= 120 ? match.name : Array.from(match.name).slice(0, 119).join("").slice(0, 119) + "…";
  }
  namespaces(query: Query = {}): OutputNamespaces {
    const record = this.#generationOf(query), root = this.#root(record), items: OutputNamespace[] = [];
    if (record.layout === "v1") items.push({ ref: "general", kind: "general", id: null, label: null, status: "active", exists: root !== null, relativePath: "" });
    let truncated = false;
    const scan = (base: string | null): Set<string> => {
      const found = new Set<string>();
      if (!root || !base) return found;
      const stat = optionalLstat(base);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return found;
      const handle = opendirSync(base);
      try {
        for (let budget = OUTPUT_FILES_LIMITS.scannedEntries; budget > 0; budget--) {
          const entry = handle.readSync(); if (!entry) return found;
          if (entry.isDirectory() && NAMESPACE_ID.test(entry.name)) found.add(entry.name);
        }
        truncated = true; return found;
      } finally { handle.closeSync(); }
    };
    const add = (kind: "bot" | "team", known: ReadonlyArray<{ id: string }>, folder: string | null) => {
      const present = scan(folder);
      const ids = [...new Set([...known.map(item => item.id).filter(id => NAMESPACE_ID.test(id)), ...present])].sort();
      for (const id of ids) {
        if (items.length > OUTPUT_FILES_LIMITS.namespaces) { truncated = true; return; }
        const active = known.some(item => item.id === id);
        items.push({ ref: `${kind}:${id}`, kind, id, label: active ? this.#label(kind, id) : null, status: active ? "active" : "orphan",
          exists: present.has(id), relativePath: `${folderOf(record.layout, kind)}/${id}` });
      }
    };
    add("bot", this.#bots(), join(record.path, folderOf(record.layout, "bot")));
    add("team", this.#teams(), join(record.path, folderOf(record.layout, "team")));
    return { version: OUTPUT_FILES_CONTRACT_VERSION, hostId: this.#hostId(), generation: record.generation, items, truncated };
  }
  entries(query: Query): OutputEntries {
    const record = this.#generationOf(query), root = this.#root(record), ref = query.namespace ?? "general", relative = query.path ?? ".";
    const namespace = this.#namespaceDirectory(record, ref);
    const limit = query.limit === undefined ? 100 : /^[1-9][0-9]{0,2}$/.test(query.limit) && Number(query.limit) <= OUTPUT_FILES_LIMITS.pageEntries ? Number(query.limit) : fail("invalid_input");
    const after = query.after;
    if (after !== undefined && (after.length < 1 || after.length > 255 || !isWellFormedText(after) || after.includes("/"))) fail("invalid_input");
    const empty: OutputEntries = { version: OUTPUT_FILES_CONTRACT_VERSION, hostId: this.#hostId(), generation: record.generation, namespace: ref,
      path: relative, exists: false, items: [], nextCursor: null, hidden: { secretLike: 0, internal: 0 }, truncated: false };
    if (!root) return empty;
    const location = this.#walk(record.path, namespace.path, relative);
    if (!location.stat) return empty;
    if (!location.stat.isDirectory()) fail("invalid_input", "not_directory");
    const names: string[] = []; let secretLike = 0, internal = 0, truncated = false;
    const handle = opendirSync(location.path);
    try {
      for (let budget = OUTPUT_FILES_LIMITS.scannedEntries; ; budget--) {
        if (budget <= 0) { truncated = true; break; }
        const entry = handle.readSync(); if (!entry) break;
        if (OUTPUT_INTERNAL_NAME.test(entry.name)) { internal++; continue; }
        if (OUTPUT_SECRET_NAME.test(entry.name)) { secretLike++; continue; }
        if (!isWellFormedText(entry.name) || /[\u0000-\u001f\u007f-\u009f]/.test(entry.name)) { internal++; continue; }
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    const after2 = lstatSync(location.path);
    if (!sameDirectory(after2, location.stat) || after2.isSymbolicLink()) fail("conflict", "changed");
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = names.filter(name => after === undefined || name > after).slice(0, limit + 1);
    const items: OutputEntry[] = page.slice(0, limit).map(name => {
      const stat = optionalLstat(join(location.path, name)), path = relative === "." ? name : `${relative}/${name}`;
      if (!stat) return { name, path, type: "blocked" as const, bytes: null, modifiedAt: null, mediaType: null };
      const type = stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1) ? "blocked" as const
        : stat.isDirectory() ? "directory" as const : "file" as const;
      return { name, path, type, bytes: type === "file" ? stat.size : null, modifiedAt: type === "blocked" ? null : Math.trunc(stat.mtimeMs),
        mediaType: type === "file" ? outputMediaType(name) : null };
    });
    return { ...empty, exists: true, items, nextCursor: page.length > limit ? items.at(-1)!.name : null, hidden: { secretLike, internal }, truncated };
  }
  /** Opens one regular, single-link file without following links; `check` runs while the descriptor is open. */
  #withFile<T>(query: Query, check: (fd: number, stat: Stats, file: { name: string; record: LocationRecord; ref: string; relative: string }) => T): T {
    const record = this.#generationOf(query), root = this.#root(record), ref = query.namespace ?? "general", relative = query.path ?? "";
    if (relative === "." || relative === "") fail("invalid_input");
    if (!root) fail("not_found");
    const namespace = this.#namespaceDirectory(record, ref), location = this.#walk(record.path, namespace.path, relative);
    if (!location.stat) fail("not_found");
    if (!location.stat!.isFile() || location.stat!.nlink !== 1) fail("forbidden", "not_regular_file");
    const fd = openSync(location.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || fileIdentity(stat) !== fileIdentity(location.stat!)) fail("conflict", "changed");
      const name = relative.split("/").at(-1)!;
      return check(fd, stat, { name, record, ref, relative });
    } finally { closeSync(fd); }
  }
  item(query: Query): OutputItem {
    return this.#withFile(query, (fd, stat, file) => {
      let digest: string | null = null;
      if (stat.size <= OUTPUT_FILES_LIMITS.hashedBytes) {
        const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let position = 0;
        for (;;) { const read = readSync(fd, buffer, 0, buffer.length, position); if (!read) break; hash.update(buffer.subarray(0, read)); position += read; }
        if (position !== stat.size || fileIdentity(fstatSync(fd)) !== fileIdentity(stat)) fail("conflict", "changed");
        digest = hash.digest("hex");
      }
      return { version: OUTPUT_FILES_CONTRACT_VERSION, hostId: this.#hostId(), generation: file.record.generation, namespace: file.ref,
        path: file.relative, name: file.name, bytes: stat.size, modifiedAt: Math.trunc(stat.mtimeMs), mediaType: outputMediaType(file.name),
        pin: fileIdentity(stat), sha256: digest, exportable: stat.size <= OUTPUT_FILES_LIMITS.exportBytes };
    });
  }
  /** One bounded chunk of an exportable file, bound to its identity pin (changed file → conflict, never mixed bytes). */
  content(query: Query): OutputContentChunk {
    if (query.pin === undefined || !/^[0-9a-f]{64}$/.test(query.pin)) fail("invalid_input");
    const offset = query.offset === undefined ? 0 : /^(0|[1-9][0-9]{0,15})$/.test(query.offset) ? Number(query.offset) : fail("invalid_input");
    const wanted = query.length === undefined ? OUTPUT_FILES_LIMITS.chunkBytes : /^[1-9][0-9]{0,8}$/.test(query.length) ? Number(query.length) : fail("invalid_input");
    if (!Number.isSafeInteger(offset) || wanted > OUTPUT_FILES_LIMITS.chunkBytes) fail("invalid_input");
    return this.#withFile(query, (fd, stat, file) => {
      if (fileIdentity(stat) !== query.pin) fail("conflict", "changed");
      if (stat.size > OUTPUT_FILES_LIMITS.exportBytes) fail("forbidden", "too_large");
      if (offset > stat.size) fail("invalid_input");
      const length = Math.min(wanted, stat.size - offset), bytes = Buffer.alloc(length); let read = 0;
      while (read < length) { const n = readSync(fd, bytes, read, length - read, offset + read); if (!n) break; read += n; }
      if (read !== length || fileIdentity(fstatSync(fd)) !== query.pin) { bytes.fill(0); fail("conflict", "changed"); }
      return { bytes, mediaType: outputMediaType(file.name), name: file.name, size: stat.size, offset };
    });
  }

  // ---- owner destination ------------------------------------------------------------------------------

  #validateOwnerPath(path: string): { path: string; device: string; inode: string } {
    if (!isAbsolute(path) || resolve(path) !== path || path === "/" || !isWellFormedText(path)) fail("invalid_input", "path");
    const stat = optionalLstat(path);
    if (!stat) fail("invalid_input", "missing");
    if (!stat!.isDirectory() || stat!.isSymbolicLink() || realpathSync(path) !== path) fail("invalid_input", "not_real_directory");
    if (typeof process.getuid === "function" && stat!.uid !== process.getuid()) fail("forbidden", "other_owner");
    if ((stat!.mode & 0o022) !== 0) fail("forbidden", "shared_writable");
    const data = this.#data();
    if (path === data || path.startsWith(data + sep) || data.startsWith(path + sep)) fail("invalid_input", "data_directory");
    let home: string | null = null;
    try { home = realpathSync(homedir()); } catch { home = null; }
    if (home && (path === home || home.startsWith(path + sep) || path === join(home, "Library") || path.startsWith(join(home, "Library") + sep))) fail("forbidden", "home_or_library");
    try { accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK); } catch { fail("forbidden", "not_writable"); }
    return { path, device: String(stat!.dev), inode: String(stat!.ino) };
  }
  receipt(clientRequestId: string): OutputDestinationReceipt | null {
    if (!REQUEST_ID.test(clientRequestId)) fail("invalid_input");
    const db = this.#open(); if (!db) return null;
    const row = db.prepare("SELECT body FROM receipts WHERE client_request_id=?").get(clientRequestId) as Row | undefined;
    return row ? JSON.parse(String(row.body)) as OutputDestinationReceipt : null;
  }
  /**
   * Owner-only CAS: new generation for NEW files; existing outputs are never moved or deleted. Same id + same body
   * replays the original receipt (after a lost ACK or a restart); same id + other body conflicts.
   */
  setDestination(raw: unknown): OutputDestinationReceipt {
    const parsed = SetOutputDestinationSchema.safeParse(raw);
    if (!parsed.success) fail("invalid_input");
    const input = parsed.data!, identity = this.#identity();
    if (!identity) fail("unavailable", "unbound");
    const hostId = identity!.hostId;
    if (input.expectedHostID !== hostId) fail("conflict", "host");
    const requestHash = sha256(canonical(input));
    return this.#writer.lease(() => {
      const prior = this.receipt(input.clientRequestId);
      if (prior) { if (prior.requestHash !== requestHash) fail("conflict", "request_reused"); return prior; }
      const target = input.destination.kind === "host_data_default"
        ? { kind: "host_data_default" as const, path: join(this.#data(), OUTPUT_FILES_DEFAULT_DIRECTORY), device: null as string | null, inode: null as string | null }
        : { kind: "owner_path" as const, ...this.#validateOwnerPath(input.destination.path) };
      if (target.kind === "host_data_default") {
        const stat = optionalLstat(target.path);
        if (stat) {
          if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(target.path) !== target.path) fail("forbidden", "default_unsafe");
          target.device = String(stat.dev); target.inode = String(stat.ino);
        }
      }
      const snapshot = this.#snapshot();
      if (snapshot.revision !== input.expectedRevision) fail("conflict", "revision");
      const current = snapshot.records.find(item => item.generation === snapshot.current)!;
      if (current.kind === target.kind && current.path === target.path) fail("conflict", "already_current");
      const generation = Math.max(...snapshot.records.map(item => item.generation)) + 1;
      if (generation > OUTPUT_FILES_LIMITS.ledgerGenerations) fail("conflict", "ledger_full");
      const db = this.#ensure(), now = this.#now();
      const receipt: OutputDestinationReceipt = { version: OUTPUT_FILES_CONTRACT_VERSION, hostId, clientRequestId: input.clientRequestId, requestHash,
        previousRevision: snapshot.revision, revision: snapshot.revision + 1, previousGeneration: current.generation, generation,
        destination: { kind: target.kind, path: target.path }, existingFilesMoved: false, createdAt: now };
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = db.prepare("SELECT revision, current_generation FROM state WHERE id=1").get() as Row;
        if (Number(state.revision) !== snapshot.revision || Number(state.current_generation) !== current.generation) fail("conflict", "revision");
        if (db.prepare("SELECT 1 AS x FROM receipts WHERE client_request_id=?").get(input.clientRequestId)) fail("conflict", "request_reused");
        db.prepare("INSERT INTO locations VALUES (?,?,?,?,?,?,?,NULL,?)").run(generation, target.kind, "v1", target.path, target.device, target.inode, now, input.clientRequestId);
        db.prepare("UPDATE locations SET retired_at=? WHERE generation=?").run(now, current.generation);
        db.prepare("UPDATE state SET revision=?, current_generation=?, updated_at=? WHERE id=1").run(snapshot.revision + 1, generation, now);
        db.prepare("INSERT INTO receipts VALUES (?,?,?,?)").run(input.clientRequestId, requestHash, JSON.stringify(receipt), now);
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already closed */ } throw error; }
      return receipt;
    });
  }

  close(): void {
    this.#closed = true; this.#turns.clear();
    if (this.#db) { this.#db.close(); this.#db = null; }
  }
}
