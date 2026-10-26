import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  AppendMessageSchema, ApprovalDecisionSchema, CreateBotSchema, DeviceInputSchema, GrantInputSchema, IdSchema,
  JsonSchema, StartTurnSchema, ToolRequestSchema, RenameDeviceSchema,
  type Action, type Bot, type Device, type Grant, type HostEvent, type JsonValue, type Message, type Thread,
  type ToolRequest,
} from "@dexter/contracts";
import { describeIssues, HostError } from "./errors.js";
import {
  MAX_TURN_OUTPUT_CHARS, NATIVE_CURSOR, TURN_EVENT_KINDS, TURN_STATES, normalizeTurnCode,
  type StartedTurn, type ThreadSession, type Turn, type TurnCode, type TurnCounts, type TurnEvent, type TurnEventKind,
  type TurnState,
} from "./turns.js";

export const SCHEMA_VERSION = 3;
export const DATABASE_FILE = "dexter.sqlite";
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;
const DEFAULT_DEVICE_TTL_MS = 2 * 60_000;
const MAX_PAGE = 500;
const MAX_RESULT_BYTES = 1024 * 1024;

export interface HostStoreOptions {
  dataDir: string;
  ownerId?: string;
  clock?: () => number;
  approvalTtlMs?: number;
  deviceTtlMs?: number;
}
export type ActionState = Action["state"];
export type ActionReason = NonNullable<Action["reason"]>;
export type UnknownReason = Extract<ActionReason, "host_interrupted" | "executor_error">;
export type DevicePresence = "online" | "stale" | "revoked";
export interface HostLease { hostname: string; pid: number; acquiredAt: number }
export interface HostSummary {
  hostId: string;
  ownerId: string;
  schemaVersion: number;
  lease: HostLease;
  counts: {
    bots: number; threads: number; messages: number; events: number; grants: number;
    devices: { online: number; stale: number; revoked: number };
    actions: Record<ActionState, number>;
  };
}

/** Trusted owner-approved app-client enrollment only; never a remote principal or agent capability. */
export const CLIENT_DEVICE_SCOPES = Object.freeze(["chat.read", "chat.write", "approvals.read", "approvals.decide", "devices.read", "devices.manage", "grants.read", "grants.manage"] as const);
export type ClientDeviceScope = typeof CLIENT_DEVICE_SCOPES[number];
export type ClientDeviceRole = "client-ios" | "client-mac";
export interface ClientDeviceClaimKey { namespace: "app-client-v1"; claimId: string }
export interface ClientDeviceClaimInput extends ClientDeviceClaimKey {
  name: string; fingerprint: string; role: ClientDeviceRole; scopes: readonly ClientDeviceScope[];
}
export interface ClientDeviceEnrollment extends ClientDeviceClaimKey {
  hostId: string; ownerId: string; deviceId: string; originalName: string; fingerprint: string;
  role: ClientDeviceRole; scopes: readonly ClientDeviceScope[]; digest: string; createdAt: number; device: Device;
}

type EventKind = HostEvent["kind"];
type Row = Record<string, unknown>;
/** Returned from a write transaction to commit its changes and then raise `error`. */
class CommitThenThrow { constructor(readonly error: HostError) {} }

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE host_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1), hostname TEXT NOT NULL, pid INTEGER NOT NULL,
  token TEXT NOT NULL, acquired_at INTEGER NOT NULL
) STRICT;
CREATE TABLE profiles (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE bots (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE threads (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE messages (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id),
  client_message_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (thread_id, client_message_id)
) STRICT;
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  bot_id TEXT, thread_id TEXT, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE grants (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), tool TEXT NOT NULL, destination TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('allow', 'ask', 'deny')), expires_at INTEGER,
  revision INTEGER NOT NULL CHECK (revision > 0), updated_at INTEGER NOT NULL, UNIQUE (bot_id, tool, destination)
) STRICT;
CREATE TABLE devices (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('macos', 'ios')),
  capabilities TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE TABLE actions (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), thread_id TEXT NOT NULL REFERENCES threads(id),
  tool TEXT NOT NULL, destination TEXT NOT NULL, idempotency_key TEXT NOT NULL, request TEXT NOT NULL,
  request_hash TEXT NOT NULL, grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'ready', 'running', 'succeeded', 'denied', 'blocked', 'unknown')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, approval_expires_at INTEGER, decided_by TEXT, result TEXT,
  reason TEXT CHECK (reason IS NULL OR reason IN ('user_denied', 'approval_expired', 'permission_changed', 'host_interrupted', 'executor_error')),
  UNIQUE (bot_id, idempotency_key)
) STRICT;
CREATE INDEX actions_by_target ON actions (bot_id, tool, destination, state);
CREATE INDEX actions_by_state ON actions (state);
CREATE INDEX threads_by_bot ON threads (bot_id);
`;

/** v2: durable conversation turns. Purely additive, so a v1 database migrates in place. */
const SCHEMA_V2 = `
CREATE TABLE thread_sessions (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')),
  native_cursor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE turns (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES threads(id),
  bot_id TEXT NOT NULL REFERENCES bots(id), engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')),
  client_request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  input_message_id TEXT NOT NULL REFERENCES messages(id), output_message_id TEXT REFERENCES messages(id),
  state TEXT NOT NULL CHECK (state IN (${TURN_STATES.map((s) => `'${s}'`).join(", ")})), code TEXT,
  output_chars INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL,
  UNIQUE (thread_id, client_request_id)
) STRICT;
CREATE INDEX turns_by_thread ON turns (thread_id, cursor);
CREATE INDEX turns_by_state ON turns (state);
CREATE TABLE turn_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES turns(id), thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${TURN_EVENT_KINDS.map((k) => `'${k}'`).join(", ")})), text TEXT, data TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX turn_events_by_turn ON turn_events (turn_id, cursor);
CREATE INDEX turn_events_by_thread ON turn_events (thread_id, cursor);
`;
/** v3: canonical claim journal and device insert commit in one Hub transaction. */
const CLIENT_ENROLLMENT_TABLE = `CREATE TABLE client_device_enrollments (
  namespace TEXT NOT NULL CHECK (namespace = 'app-client-v1'), claim_id TEXT NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 128),
  host_key TEXT NOT NULL DEFAULT 'host_id' CHECK (host_key = 'host_id') REFERENCES meta(key),
  owner_key TEXT NOT NULL DEFAULT 'owner_id' CHECK (owner_key = 'owner_id') REFERENCES meta(key),
  host_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(id),
  original_name TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0), PRIMARY KEY (namespace, claim_id)
) STRICT`;
const CLIENT_ENROLLMENT_UPDATE = `CREATE TRIGGER client_enrollment_no_update BEFORE UPDATE ON client_device_enrollments
BEGIN SELECT RAISE(ABORT, 'client enrollment is immutable'); END`;
const CLIENT_ENROLLMENT_DELETE = `CREATE TRIGGER client_enrollment_no_delete BEFORE DELETE ON client_device_enrollments
BEGIN SELECT RAISE(ABORT, 'client enrollment is immutable'); END`;
const SCHEMA_V3 = `${CLIENT_ENROLLMENT_TABLE};${CLIENT_ENROLLMENT_UPDATE};${CLIENT_ENROLLMENT_DELETE};`;
const MIGRATIONS: ReadonlyArray<string> = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];
const CLIENT_CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLIENT_FINGERPRINT = /^[0-9a-f]{64}$/;
const CLIENT_INPUT_BYTES = 2048;
function clientRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new HostError("invalid_input", "Invalid client enrollment input.");
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) throw new HostError("invalid_input", "Invalid client enrollment fields.");
  const record: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) throw new HostError("invalid_input", "Invalid client enrollment fields.");
    record[key] = descriptor.value;
  }
  return record;
}
function clientClaimKey(input: unknown): ClientDeviceClaimKey {
  const raw = clientRecord(input, ["namespace", "claimId"]);
  if (raw.namespace !== "app-client-v1" || typeof raw.claimId !== "string" || !CLIENT_CLAIM_ID.test(raw.claimId))
    throw new HostError("invalid_input", "Invalid client claim key.");
  return { namespace: "app-client-v1", claimId: raw.claimId };
}
function clientClaimInput(input: unknown): ClientDeviceClaimInput {
  const raw = clientRecord(input, ["namespace", "claimId", "name", "fingerprint", "role", "scopes"]);
  const key = clientClaimKey({ namespace: raw.namespace, claimId: raw.claimId });
  if (typeof raw.name !== "string" || /\p{Cc}/u.test(raw.name) || Buffer.byteLength(raw.name, "utf8") > 480
    || Buffer.from(raw.name, "utf8").toString("utf8") !== raw.name
    || typeof raw.fingerprint !== "string" || !CLIENT_FINGERPRINT.test(raw.fingerprint)
    || (raw.role !== "client-ios" && raw.role !== "client-mac") || !Array.isArray(raw.scopes) || raw.scopes.length > CLIENT_DEVICE_SCOPES.length)
    throw new HostError("invalid_input", "Invalid client enrollment input.");
  const scopes: ClientDeviceScope[] = [];
  for (let i = 0; i < raw.scopes.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw.scopes, String(i));
    if (!descriptor || !("value" in descriptor) || !CLIENT_DEVICE_SCOPES.includes(descriptor.value) || scopes.includes(descriptor.value))
      throw new HostError("invalid_input", "Invalid client scopes.");
    scopes.push(descriptor.value as ClientDeviceScope);
  }
  scopes.sort();
  const device = parse(DeviceInputSchema, { name: raw.name, platform: raw.role === "client-ios" ? "ios" : "macos", capabilities: [] });
  const normalized: ClientDeviceClaimInput = { ...key, name: device.name, fingerprint: raw.fingerprint, role: raw.role, scopes };
  if (Buffer.byteLength(JSON.stringify({ ...normalized, name: raw.name }), "utf8") > CLIENT_INPUT_BYTES) throw new HostError("invalid_input", "Client enrollment is too large.");
  return normalized;
}
function clientDigest(input: ClientDeviceClaimInput, hostId: string, ownerId: string): string {
  return createHash("sha256").update(canonicalJson({ ...input, scopes: [...input.scopes], hostId, ownerId })).digest("hex");
}


/** Key names that denote credentials. Matching keys are refused in arguments and redacted in results. */
const SECRET_KEY = /(?:secret|password|passwd|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|session[_-]?token|authorization|cookie|private[_-]?key|credentials?)$/i;

function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }> } } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HostError("invalid_input", describeIssues(parsed.error.issues));
  return parsed.data;
}

/** Deterministic JSON: object keys sorted recursively, so equal requests hash equally. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
}
export function hashRequest(request: ToolRequest): string {
  return createHash("sha256").update(canonicalJson(request as unknown as JsonValue)).digest("hex");
}
function findSecretKey(value: JsonValue): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findSecretKey(item); if (found) return found; }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) return key;
    const found = findSecretKey(item as JsonValue);
    if (found) return found;
  }
  return null;
}
function redactSecrets(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(item as JsonValue)]));
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function newId(prefix: string): string { return `${prefix}_${randomUUID()}`; }

const str = (row: Row, key: string): string => row[key] as string;
const num = (row: Row, key: string): number => Number(row[key]);
const nnum = (row: Row, key: string): number | null => (row[key] === null ? null : Number(row[key]));
const nstr = (row: Row, key: string): string | null => (row[key] === null ? null : (row[key] as string));

export class HostStore {
  readonly hostId: string;
  readonly ownerId: string;
  readonly databasePath: string;
  readonly approvalTtlMs: number;
  readonly deviceTtlMs: number;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly leaseToken = randomBytes(32).toString("hex");
  private closed = false;

  constructor(options: HostStoreOptions) {
    this.clock = options.clock ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.deviceTtlMs = options.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS;
    if (options.ownerId !== undefined) parse(IdSchema, options.ownerId);
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.databasePath = join(options.dataDir, DATABASE_FILE);
    this.db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, timeout: 5_000 });
    try {
      chmodSync(this.databasePath, 0o600);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      const mode = this.db.prepare("PRAGMA journal_mode").get() as Row;
      if (String(mode.journal_mode).toLowerCase() !== "wal") throw new HostError("conflict", "database could not enter WAL mode");
      const opened = this.immediate(() => this.openInTransaction(options.ownerId));
      this.hostId = opened.hostId;
      this.ownerId = opened.ownerId;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.immediate(() => { this.db.prepare("DELETE FROM host_lease WHERE id = 1 AND token = ?").run(this.leaseToken); });
    } finally {
      this.db.close();
    }
  }

  /** The store's clock; approval and grant expiry are judged against it. */
  now(): number { return this.clock(); }

  // ---- bots, threads, messages -------------------------------------------------------------

  createBot(input: unknown): Bot {
    const data = parse(CreateBotSchema, input);
    return this.write(() => {
      const now = this.clock();
      this.db.prepare("INSERT INTO profiles (id, owner_id, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .run(data.profileId, this.ownerId, now);
      const profile = this.db.prepare("SELECT owner_id FROM profiles WHERE id = ?").get(data.profileId) as Row;
      if (str(profile, "owner_id") !== this.ownerId) throw new HostError("forbidden", "profile belongs to another owner");
      const bot: Bot = { id: newId("bot"), ownerId: this.ownerId, createdAt: now, ...data };
      this.db.prepare("INSERT INTO bots (id, owner_id, profile_id, name, engine, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(bot.id, bot.ownerId, bot.profileId, bot.name, bot.engine, bot.createdAt);
      this.emit("bot.created", bot.id, null, bot.id);
      return bot;
    });
  }
  listBots(): Bot[] {
    return this.all("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at, id", this.ownerId).map(toBot);
  }
  getBot(id: string): Bot {
    const row = this.one("SELECT * FROM bots WHERE id = ? AND owner_id = ?", id, this.ownerId);
    if (!row) throw new HostError("not_found", "bot not found");
    return toBot(row);
  }

  createThread(botId: string): Thread {
    return this.write(() => {
      this.getBot(botId);
      const thread: Thread = { id: newId("thr"), botId, createdAt: this.clock() };
      this.db.prepare("INSERT INTO threads (id, bot_id, created_at) VALUES (?, ?, ?)").run(thread.id, botId, thread.createdAt);
      this.emit("thread.created", botId, thread.id, thread.id);
      return thread;
    });
  }
  getThread(id: string): Thread {
    const row = this.one("SELECT t.* FROM threads t JOIN bots b ON b.id = t.bot_id WHERE t.id = ? AND b.owner_id = ?", id, this.ownerId);
    if (!row) throw new HostError("not_found", "thread not found");
    return { id: str(row, "id"), botId: str(row, "bot_id"), createdAt: num(row, "created_at") };
  }

  /** Idempotent by (thread, clientMessageId): a replay returns the stored message; a different payload conflicts. */
  appendMessage(threadId: string, input: unknown, role: Message["role"] = "user"): Message {
    const data = parse(AppendMessageSchema, input);
    if (role !== "user" && role !== "assistant") throw new HostError("invalid_input", "role: invalid_value");
    return this.write(() => {
      const thread = this.getThread(threadId);
      const existing = this.one("SELECT * FROM messages WHERE thread_id = ? AND client_message_id = ?", threadId, data.clientMessageId);
      if (existing) {
        if (str(existing, "content") !== data.content || str(existing, "role") !== role) {
          throw new HostError("conflict", "clientMessageId reused with different content");
        }
        return toMessage(existing);
      }
      const id = newId("msg");
      const now = this.clock();
      this.db.prepare("INSERT INTO messages (id, thread_id, client_message_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, threadId, data.clientMessageId, role, data.content, now);
      this.emit("message.appended", thread.botId, threadId, id);
      return toMessage(this.one("SELECT * FROM messages WHERE id = ?", id)!);
    });
  }
  listMessages(threadId: string, after = 0, limit = 100): Message[] {
    this.getThread(threadId);
    return this.all("SELECT * FROM messages WHERE thread_id = ? AND cursor > ? ORDER BY cursor LIMIT ?",
      threadId, cursorArg(after), pageArg(limit)).map(toMessage);
  }
  listEvents(after = 0, limit = 100): HostEvent[] {
    return this.all("SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?", cursorArg(after), pageArg(limit)).map((row) => ({
      cursor: num(row, "cursor"), id: str(row, "id"), kind: str(row, "kind") as EventKind,
      botId: nstr(row, "bot_id"), threadId: nstr(row, "thread_id"), entityId: str(row, "entity_id"), createdAt: num(row, "created_at"),
    }));
  }

  // ---- grants --------------------------------------------------------------------------------

  /** Every change bumps the revision and blocks pending actions bound to the previous revision. */
  setGrant(input: unknown): Grant {
    const data = parse(GrantInputSchema, input);
    return this.write(() => {
      this.getBot(data.botId);
      const now = this.clock();
      const previous = this.grantRow(data.botId, data.tool, data.destination);
      const id = previous ? str(previous, "id") : newId("grt");
      const revision = previous ? num(previous, "revision") + 1 : 1;
      this.db.prepare(`INSERT INTO grants (id, bot_id, tool, destination, policy, expires_at, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, tool, destination) DO UPDATE SET policy = excluded.policy, expires_at = excluded.expires_at,
          revision = excluded.revision, updated_at = excluded.updated_at`)
        .run(id, data.botId, data.tool, data.destination, data.policy, data.expiresAt, revision, now);
      this.emit("grant.changed", data.botId, null, id);
      for (const row of this.all(`SELECT id FROM actions WHERE bot_id = ? AND tool = ? AND destination = ?
          AND state IN ('awaiting_approval', 'ready')`, data.botId, data.tool, data.destination)) {
        this.transition(str(row, "id"), "blocked", "permission_changed", "action.blocked");
      }
      return { ...data, revision };
    });
  }
  getGrant(botId: string, tool: string, destination: string): Grant | null {
    const row = this.grantRow(botId, tool, destination);
    return row ? toGrant(row) : null;
  }

  // ---- actions -------------------------------------------------------------------------------

  /**
   * Records a tool request against the current grant. Replays with the same (bot, idempotencyKey) and
   * identical request return the stored action; a different request under the same key conflicts.
   * Requests without an effective grant are refused without persisting anything.
   */
  requestAction(input: unknown): Action {
    const request = parse(ToolRequestSchema, input);
    const secretKey = findSecretKey(request.arguments);
    if (secretKey !== null) throw new HostError("invalid_input", "arguments must not carry credentials; inject them in the trusted executor");
    const requestHash = hashRequest(request);
    return this.write(() => {
      const existing = this.one("SELECT * FROM actions WHERE bot_id = ? AND idempotency_key = ?", request.botId, request.idempotencyKey);
      if (existing) {
        if (str(existing, "request_hash") !== requestHash) throw new HostError("conflict", "idempotencyKey reused with a different request");
        return toAction(existing);
      }
      const thread = this.getThread(request.threadId);
      if (thread.botId !== request.botId) throw new HostError("forbidden", "thread belongs to another bot");
      const now = this.clock();
      const grant = this.effectiveGrant(request.botId, request.tool, request.destination, now);
      if (!grant) throw new HostError("forbidden", "no effective grant for this bot, tool and destination");
      const state: ActionState = grant.policy === "allow" ? "ready" : "awaiting_approval";
      const approvalExpiresAt = state === "awaiting_approval"
        ? Math.min(now + this.approvalTtlMs, grant.expiresAt ?? Number.MAX_SAFE_INTEGER) : null;
      const id = newId("act");
      this.db.prepare(`INSERT INTO actions (id, bot_id, thread_id, tool, destination, idempotency_key, request, request_hash,
          grant_revision, state, created_at, updated_at, approval_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, request.botId, request.threadId, request.tool, request.destination, request.idempotencyKey,
          canonicalJson(request as unknown as JsonValue), requestHash, grant.revision, state, now, now, approvalExpiresAt);
      this.emit("action.created", request.botId, request.threadId, id);
      return this.getAction(id);
    });
  }
  getAction(id: string): Action {
    const row = this.one("SELECT a.* FROM actions a JOIN bots b ON b.id = a.bot_id WHERE a.id = ? AND b.owner_id = ?", id, this.ownerId);
    if (!row) throw new HostError("not_found", "action not found");
    return toAction(row);
  }
  /** Indexed replay lookup scoped to this installation's owner and the bot. */
  findAction(botId: string, idempotencyKey: string): Action | null {
    const row = this.one(`SELECT a.* FROM actions a JOIN bots b ON b.id = a.bot_id
      WHERE a.bot_id = ? AND a.idempotency_key = ? AND b.owner_id = ?`, botId, idempotencyKey, this.ownerId);
    return row ? toAction(row) : null;
  }
  listActions(state?: ActionState): Action[] {
    const rows = state === undefined
      ? this.all("SELECT a.* FROM actions a JOIN bots b ON b.id = a.bot_id WHERE b.owner_id = ? ORDER BY a.created_at, a.rowid", this.ownerId)
      : this.all("SELECT a.* FROM actions a JOIN bots b ON b.id = a.bot_id WHERE b.owner_id = ? AND a.state = ? ORDER BY a.created_at, a.rowid", this.ownerId, state);
    return rows.map(toAction);
  }

  /**
   * Owner decision bound to the exact request hash. Only the first decision on an awaiting action wins.
   * Expired approvals and changed grants are persisted as terminal states before the error is raised.
   */
  decideAction(id: string, input: unknown): Action {
    const decision = parse(ApprovalDecisionSchema, input);
    return this.write(() => {
      const action = this.getAction(id);
      if (action.state !== "awaiting_approval") throw new HostError("conflict", `action is ${action.state}`);
      if (decision.requestHash !== action.requestHash) throw new HostError("conflict", "approval does not match the requested arguments");
      const now = this.clock();
      if (action.approvalExpiresAt !== null && now >= action.approvalExpiresAt) {
        this.transition(id, "denied", "approval_expired", "action.decided");
        return new CommitThenThrow(new HostError("conflict", "approval expired"));
      }
      if (decision.decision === "deny") {
        return this.transition(id, "denied", "user_denied", "action.decided", this.ownerId);
      }
      if (!this.grantStillValid(action, now)) {
        this.transition(id, "blocked", "permission_changed", "action.blocked");
        return new CommitThenThrow(new HostError("forbidden", "grant changed since the request"));
      }
      return this.transition(id, "ready", null, "action.decided", this.ownerId);
    });
  }

  /**
   * Atomically revalidates grant and destination, then moves ready -> running. Synchronous by design:
   * no await can interleave between the policy check and the claim. Offline devices leave the action ready.
   */
  claimAction(id: string): Action {
    return this.write(() => {
      const action = this.getAction(id);
      if (action.state !== "ready") throw new HostError("conflict", `action is ${action.state}`);
      const now = this.clock();
      if (action.approvalExpiresAt !== null && now >= action.approvalExpiresAt) {
        this.transition(id, "denied", "approval_expired", "action.decided");
        return new CommitThenThrow(new HostError("conflict", "approval expired before dispatch"));
      }
      if (!this.grantStillValid(action, now)) {
        this.transition(id, "blocked", "permission_changed", "action.blocked");
        return new CommitThenThrow(new HostError("forbidden", "grant changed since the request"));
      }
      const device = this.one("SELECT * FROM devices WHERE id = ? AND owner_id = ?", action.request.destination, this.ownerId);
      if (!device && action.request.destination.startsWith("dev_")) {
        this.transition(id, "blocked", "permission_changed", "action.blocked");
        return new CommitThenThrow(new HostError("forbidden", "destination device is not registered"));
      }
      if (device) {
        const capabilities = JSON.parse(str(device, "capabilities")) as string[];
        if (nnum(device, "revoked_at") !== null || !capabilities.includes(action.request.tool)) {
          this.transition(id, "blocked", "permission_changed", "action.blocked");
          return new CommitThenThrow(new HostError("forbidden", "destination device revoked or lacks this capability"));
        }
        if (presenceOf(device, now, this.deviceTtlMs) !== "online") {
          return new CommitThenThrow(new HostError("device_unavailable", "destination device is offline; action stays ready"));
        }
      }
      return this.transition(id, "running", null, "action.started");
    });
  }

  completeAction(id: string, result: unknown): Action {
    let encoded: string;
    try {
      const parsed = JsonSchema.safeParse(result);
      const stored: JsonValue = parsed.success ? redactSecrets(parsed.data) : { omitted: "result_not_json" };
      encoded = canonicalJson(stored);
      if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) encoded = canonicalJson({ omitted: "result_too_large" });
    } catch {
      // Circular/deep objects or hostile getters can throw even inside safeParse. Never persist their errors.
      encoded = canonicalJson({ omitted: "result_not_json" });
    }
    return this.write(() => {
      const action = this.getAction(id);
      if (action.state !== "running") throw new HostError("conflict", `action is ${action.state}`);
      this.db.prepare("UPDATE actions SET result = ? WHERE id = ?").run(encoded, id);
      return this.transition(id, "succeeded", null, "action.succeeded");
    });
  }

  /** Outcome of a started action cannot be known; it is terminal and never retried automatically. */
  markUnknown(id: string, reason: UnknownReason): Action {
    if (reason !== "host_interrupted" && reason !== "executor_error") throw new HostError("invalid_input", "reason: invalid_value");
    return this.write(() => {
      const action = this.getAction(id);
      if (action.state !== "running") throw new HostError("conflict", `action is ${action.state}`);
      return this.transition(id, "unknown", reason, "action.unknown");
    });
  }

  /** Persists expiry of approvals nobody answered in time. Returns how many were expired. */
  expireApprovals(): number {
    return this.write(() => {
      const rows = this.all("SELECT id FROM actions WHERE state = 'awaiting_approval' AND approval_expires_at <= ?", this.clock());
      for (const row of rows) this.transition(str(row, "id"), "denied", "approval_expired", "action.decided");
      return rows.length;
    });
  }


  // ---- turns ---------------------------------------------------------------------------------

  /**
   * Accepts a user input durably: input message, thread engine binding, queued turn and `turn.queued`
   * commit together. Idempotent by (thread, clientRequestId); a different content under the same id conflicts.
   * The thread is bound to its bot's engine on first use; a later engine change is refused.
   */
  createTurn(threadId: string, input: unknown): StartedTurn {
    const data = parse(StartTurnSchema, input);
    const inputHash = createHash("sha256").update(data.content).digest("hex");
    return this.write(() => {
      const thread = this.getThread(threadId);
      const existing = this.one("SELECT * FROM turns WHERE thread_id = ? AND client_request_id = ?", threadId, data.clientRequestId);
      if (existing) {
        if (str(existing, "input_hash") !== inputHash) throw new HostError("conflict", "clientRequestId reused with different content");
        return { turn: toTurn(existing), created: false };
      }
      const bot = this.getBot(thread.botId);
      const now = this.clock();
      const session = this.one("SELECT engine FROM thread_sessions WHERE thread_id = ?", threadId);
      if (session && str(session, "engine") !== bot.engine) throw new HostError("conflict", "thread is bound to another engine");
      if (!session) {
        this.db.prepare("INSERT INTO thread_sessions (thread_id, engine, native_cursor, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)")
          .run(threadId, bot.engine, now, now);
      }
      const id = newId("turn");
      const messageId = this.insertMessage(threadId, thread.botId, `turn-in:${id}`, "user", data.content, now);
      this.db.prepare(`INSERT INTO turns (id, thread_id, bot_id, engine, client_request_id, input_hash, input_message_id, state,
          created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(id, threadId, thread.botId, bot.engine, data.clientRequestId, inputHash, messageId, now, now);
      this.turnEvent(id, threadId, "turn.queued", null, null, now);
      return { turn: this.getTurn(id), created: true };
    });
  }
  findTurn(threadId: string, clientRequestId: string): Turn | null {
    this.getThread(threadId);
    const row = this.one("SELECT * FROM turns WHERE thread_id = ? AND client_request_id = ?", threadId, clientRequestId);
    return row ? toTurn(row) : null;
  }
  getTurn(id: string): Turn {
    const row = this.one("SELECT t.* FROM turns t JOIN bots b ON b.id = t.bot_id WHERE t.id = ? AND b.owner_id = ?", id, this.ownerId);
    if (!row) throw new HostError("not_found", "turn not found");
    return toTurn(row);
  }
  /** The stored user input of a turn; only the runtime passes it to a driver. */
  turnInput(id: string): string {
    const turn = this.getTurn(id);
    return str(this.one("SELECT content FROM messages WHERE id = ?", turn.inputMessageId)!, "content");
  }
  listTurns(threadId: string, after = 0, limit = 100): Turn[] {
    this.getThread(threadId);
    return this.all("SELECT * FROM turns WHERE thread_id = ? AND cursor > ? ORDER BY cursor LIMIT ?",
      threadId, cursorArg(after), pageArg(limit)).map(toTurn);
  }
  listTurnsByState(state: TurnState): Turn[] {
    return this.all("SELECT t.* FROM turns t JOIN bots b ON b.id = t.bot_id WHERE b.owner_id = ? AND t.state = ? ORDER BY t.cursor",
      this.ownerId, state).map(toTurn);
  }
  /** Replayable stream by cursor, for one turn or a whole thread. */
  listTurnEvents(scope: { turnId: string } | { threadId: string }, after = 0, limit = 100): TurnEvent[] {
    const rows = "turnId" in scope
      ? (this.getTurn(scope.turnId), this.all("SELECT * FROM turn_events WHERE turn_id = ? AND cursor > ? ORDER BY cursor LIMIT ?",
        scope.turnId, cursorArg(after), pageArg(limit)))
      : (this.getThread(scope.threadId), this.all("SELECT * FROM turn_events WHERE thread_id = ? AND cursor > ? ORDER BY cursor LIMIT ?",
        scope.threadId, cursorArg(after), pageArg(limit)));
    return rows.map(toTurnEvent);
  }
  getThreadSession(threadId: string): ThreadSession | null {
    this.getThread(threadId);
    const row = this.one("SELECT * FROM thread_sessions WHERE thread_id = ?", threadId);
    return row ? {
      threadId, engine: str(row, "engine") as ThreadSession["engine"], nativeCursor: nstr(row, "native_cursor"), updatedAt: num(row, "updated_at"),
    } : null;
  }
  turnCounts(): TurnCounts {
    const counts = Object.fromEntries(TURN_STATES.map((state) => [state, 0])) as TurnCounts;
    for (const row of this.all("SELECT state, COUNT(*) AS n FROM turns GROUP BY state")) counts[str(row, "state") as TurnState] = num(row, "n");
    return counts;
  }

  /**
   * Starts the oldest queued turn of a thread unless one is already running there (one turn per thread).
   * Returns null when the head of the queue is in `held` (stranded by a restart and not yet resumed).
   */
  claimNextTurn(threadId: string, held: ReadonlySet<string> = new Set()): Turn | null {
    return this.write(() => {
      if (this.one("SELECT 1 AS x FROM turns WHERE thread_id = ? AND state = 'running'", threadId)) return null;
      const next = this.one("SELECT * FROM turns WHERE thread_id = ? AND state = 'queued' ORDER BY cursor LIMIT 1", threadId);
      if (!next || held.has(str(next, "id"))) return null;
      const now = this.clock();
      this.db.prepare("UPDATE turns SET state = 'running', started_at = ?, updated_at = ? WHERE id = ?").run(now, now, str(next, "id"));
      this.turnEvent(str(next, "id"), threadId, "turn.started", null, null, now);
      return this.getTurn(str(next, "id"));
    });
  }
  /** Persists one output delta of a running turn, clipped to the output limit. Returns the stored text. */
  appendTurnDelta(id: string, text: string): string {
    if (typeof text !== "string" || text.length === 0) return "";
    return this.write(() => {
      const turn = this.getTurn(id);
      if (turn.state !== "running") throw new HostError("conflict", `turn is ${turn.state}`);
      const room = MAX_TURN_OUTPUT_CHARS - turn.outputChars;
      let kept = text.length <= room ? text : text.slice(0, Math.max(room, 0));
      // Never store half of a surrogate pair.
      if (kept.length > 0 && kept.length < text.length && /[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
      const now = this.clock();
      if (kept.length < text.length) this.db.prepare("UPDATE turns SET output_truncated = 1, updated_at = ? WHERE id = ?").run(now, id);
      if (kept.length === 0) return "";
      this.db.prepare("UPDATE turns SET output_chars = output_chars + ?, updated_at = ? WHERE id = ?").run(kept.length, now, id);
      this.turnEvent(id, turn.threadId, "text.delta", kept, null, now);
      return kept;
    });
  }
  /** Tool lifecycle markers on the turn stream. Only ids, states and codes are accepted. */
  recordToolEvent(id: string, kind: "tool.requested" | "tool.resolved", data: Record<string, string | number | null>): void {
    this.write(() => {
      const turn = this.getTurn(id);
      if (turn.state !== "running") throw new HostError("conflict", `turn is ${turn.state}`);
      this.turnEvent(id, turn.threadId, kind, null, data, this.clock());
    });
  }
  /**
   * Single terminal transition of a running turn. A completed turn stores the assistant message built from
   * exactly the persisted deltas (so replay and message always agree) and, in the same transaction, the
   * native cursor that resumes after it. Other outcomes keep the previous cursor.
   */
  finishTurn(id: string, state: Exclude<TurnState, "queued" | "running">, code: TurnCode | null, nativeCursor?: string): Turn {
    return this.write(() => {
      const turn = this.getTurn(id);
      if (turn.state !== "running") throw new HostError("conflict", `turn is ${turn.state}`);
      const now = this.clock();
      let outputMessageId: string | null = null;
      if (state === "completed") {
        const text = this.all("SELECT text FROM turn_events WHERE turn_id = ? AND kind = 'text.delta' ORDER BY cursor", id)
          .map((row) => str(row, "text")).join("");
        if (text.length > 0) outputMessageId = this.insertMessage(turn.threadId, turn.botId, `turn-out:${id}`, "assistant", text, now);
        if (nativeCursor !== undefined && NATIVE_CURSOR.test(nativeCursor)) {
          this.db.prepare("UPDATE thread_sessions SET native_cursor = ?, updated_at = ? WHERE thread_id = ? AND engine = ?")
            .run(nativeCursor, now, turn.threadId, turn.engine);
        }
      }
      const stored = code === null ? null : normalizeTurnCode(code);
      this.db.prepare("UPDATE turns SET state = ?, code = ?, output_message_id = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .run(state, stored, outputMessageId, now, now, id);
      this.turnEvent(id, turn.threadId, `turn.${state}`, null, { code: stored, outputMessageId }, now);
      return this.getTurn(id);
    });
  }
  /** queued -> interrupted(cancelled). Running turns are cancelled through the runtime. */
  cancelQueuedTurn(id: string): Turn {
    return this.write(() => {
      const turn = this.getTurn(id);
      if (turn.state !== "queued") return turn;
      const now = this.clock();
      this.db.prepare("UPDATE turns SET state = 'interrupted', code = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      this.turnEvent(id, turn.threadId, "turn.interrupted", null, { code: "cancelled", outputMessageId: null }, now);
      return this.getTurn(id);
    });
  }
  /**
   * Abandons an action that has not started (awaiting_approval or ready) so a late approval can never
   * dispatch it. Running and terminal actions are returned unchanged.
   */
  withdrawAction(id: string, reason: "user_denied" | "approval_expired"): Action {
    return this.write(() => {
      const action = this.getAction(id);
      if (action.state !== "awaiting_approval" && action.state !== "ready") return action;
      return this.transition(id, "denied", reason, "action.decided");
    });
  }

  /** Authority changed before execution; this is a block, rather than an owner denial. */
  blockAction(id: string): Action {
    return this.write(() => {
      const action = this.getAction(id);
      if (action.state !== "awaiting_approval" && action.state !== "ready") return action;
      return this.transition(id, "blocked", "permission_changed", "action.blocked");
    });
  }

  /**
   * Holds the canonical writer fence during a trusted, synchronous metadata mutation in an extension.
   * The callback must commit its own metadata synchronously and must not call other HostStore writes.
   * This is an internal host seam, never an engine-facing capability or a distributed transaction.
   */
  withWriterLease<T>(operation: () => T): T {
    return this.write(() => {
      const result = operation();
      if (result !== null && typeof result === "object" && "then" in result) {
        throw new HostError("invalid_input", "writer callback must be synchronous");
      }
      return result;
    });
  }

  // ---- devices -------------------------------------------------------------------------------

  /** Owner-approved trusted seam: stores the device, immutable enrollment and one event atomically. No grants. */
  registerClientDeviceForClaim(input: ClientDeviceClaimInput): ClientDeviceEnrollment {
    const claim = clientClaimInput(input);
    return this.write(() => {
      this.validateClientEnrollmentSchema();
      this.assertClientAuthority(this.hostId, this.ownerId);
      const digest = clientDigest(claim, this.hostId, this.ownerId);
      const existing = this.one("SELECT * FROM client_device_enrollments WHERE namespace = ? AND claim_id = ?", claim.namespace, claim.claimId);
      if (existing) {
        const enrollment = this.clientEnrollment(existing, this.hostId, this.ownerId);
        if (enrollment.digest !== digest) throw new HostError("conflict", "Client claim was already enrolled with different metadata.");
        return enrollment;
      }
      if (this.one("SELECT 1 FROM client_device_enrollments WHERE fingerprint = ?", claim.fingerprint))
        throw new HostError("conflict", "Client certificate was already enrolled.");
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new HostError("invalid_input", "Invalid enrollment timestamp.");
      const device: Device = { id: newId("dev"), ownerId: this.ownerId, name: claim.name,
        platform: claim.role === "client-ios" ? "ios" : "macos", capabilities: [], lastSeenAt: now, revokedAt: null };
      this.db.prepare(`INSERT INTO devices (id, owner_id, name, platform, capabilities, created_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, '[]', ?, ?, NULL)`).run(device.id, this.ownerId, device.name, device.platform, now, now);
      this.db.prepare(`INSERT INTO client_device_enrollments
        (namespace, claim_id, host_id, owner_id, device_id, original_name, fingerprint, role, scopes, digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(claim.namespace, claim.claimId, this.hostId, this.ownerId,
        device.id, claim.name, claim.fingerprint, claim.role, JSON.stringify(claim.scopes), digest, now);
      this.emitRaw("device.registered", null, null, device.id, now);
      return this.clientEnrollment(this.one("SELECT * FROM client_device_enrollments WHERE namespace = ? AND claim_id = ?", claim.namespace, claim.claimId)!, this.hostId, this.ownerId);
    });
  }
  /** Trusted writer-fenced recovery lookup. Missing is null; inconsistent/foreign metadata fails closed. */
  findClientDeviceEnrollment(input: ClientDeviceClaimKey): ClientDeviceEnrollment | null {
    const key = clientClaimKey(input);
    return this.write(() => {
      this.validateClientEnrollmentSchema();
      this.assertClientAuthority(this.hostId, this.ownerId);
      const row = this.one("SELECT * FROM client_device_enrollments WHERE namespace = ? AND claim_id = ?", key.namespace, key.claimId);
      return row ? this.clientEnrollment(row, this.hostId, this.ownerId) : null;
    });
  }

  registerDevice(input: unknown): Device {
    const data = parse(DeviceInputSchema, input);
    return this.write(() => {
      const now = this.clock();
      const device: Device = { id: newId("dev"), ownerId: this.ownerId, lastSeenAt: now, revokedAt: null, ...data,
        capabilities: [...new Set(data.capabilities)] };
      this.db.prepare(`INSERT INTO devices (id, owner_id, name, platform, capabilities, created_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(device.id, device.ownerId, device.name, device.platform, JSON.stringify(device.capabilities), now, now);
      this.emit("device.registered", null, null, device.id);
      return device;
    });
  }
  listDevices(): Device[] {
    return this.all("SELECT * FROM devices WHERE owner_id = ? ORDER BY created_at, id", this.ownerId).map(toDevice);
  }
  getDevice(id: string): Device {
    return toDevice(this.deviceRow(id));
  }
  /** Owner-scoped metadata only: changing a label never changes capabilities, pins or grants. */
  renameDevice(id: string, input: unknown): Device {
    const { name } = parse(RenameDeviceSchema, input);
    return this.write(() => {
      const row = this.deviceRow(id);
      if (str(row, "name") === name) return toDevice(row);
      this.db.prepare("UPDATE devices SET name = ? WHERE id = ? AND owner_id = ?").run(name, id, this.ownerId);
      this.emit("device.renamed", null, null, id);
      return toDevice(this.deviceRow(id));
    });
  }
  devicePresence(id: string): DevicePresence {
    return presenceOf(this.deviceRow(id), this.clock(), this.deviceTtlMs);
  }
  heartbeatDevice(id: string): Device {
    return this.write(() => {
      const row = this.deviceRow(id);
      if (nnum(row, "revoked_at") !== null) throw new HostError("forbidden", "device revoked");
      this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.clock(), id);
      this.emit("device.seen", null, null, id);
      return toDevice(this.deviceRow(id));
    });
  }
  /** Irreversible. Pending actions targeting the device are blocked in the same transaction. */
  revokeDevice(id: string): Device {
    return this.write(() => {
      const row = this.deviceRow(id);
      if (nnum(row, "revoked_at") !== null) return toDevice(row);
      this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(this.clock(), id);
      this.emit("device.revoked", null, null, id);
      for (const action of this.all("SELECT id FROM actions WHERE destination = ? AND state IN ('awaiting_approval', 'ready')", id)) {
        this.transition(str(action, "id"), "blocked", "permission_changed", "action.blocked");
      }
      return toDevice(this.deviceRow(id));
    });
  }

  /** Counts and status only; never message content, arguments or results. */
  summary(): HostSummary {
    const count = (sql: string): number => num(this.one(sql)!, "n");
    const actions = { awaiting_approval: 0, ready: 0, running: 0, succeeded: 0, denied: 0, blocked: 0, unknown: 0 } satisfies Record<ActionState, number>;
    for (const row of this.all("SELECT state, COUNT(*) AS n FROM actions GROUP BY state")) actions[str(row, "state") as ActionState] = num(row, "n");
    const devices = { online: 0, stale: 0, revoked: 0 };
    const now = this.clock();
    for (const row of this.all("SELECT * FROM devices WHERE owner_id = ?", this.ownerId)) devices[presenceOf(row, now, this.deviceTtlMs)] += 1;
    const lease = this.one("SELECT * FROM host_lease WHERE id = 1");
    if (!lease || str(lease, "token") !== this.leaseToken) throw new HostError("host_locked", "host lease is no longer held");
    return {
      hostId: this.hostId, ownerId: this.ownerId, schemaVersion: SCHEMA_VERSION,
      lease: { hostname: str(lease, "hostname"), pid: num(lease, "pid"), acquiredAt: num(lease, "acquired_at") },
      counts: {
        bots: count("SELECT COUNT(*) AS n FROM bots"), threads: count("SELECT COUNT(*) AS n FROM threads"),
        messages: count("SELECT COUNT(*) AS n FROM messages"), events: count("SELECT COUNT(*) AS n FROM events"),
        grants: count("SELECT COUNT(*) AS n FROM grants"), devices, actions,
      },
    };
  }

  // ---- internals -----------------------------------------------------------------------------

  private validateClientEnrollmentSchema(): void {
    const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
    for (const [name, expected] of [["client_device_enrollments", CLIENT_ENROLLMENT_TABLE],
      ["client_enrollment_no_update", CLIENT_ENROLLMENT_UPDATE], ["client_enrollment_no_delete", CLIENT_ENROLLMENT_DELETE]]) {
      const row = this.one("SELECT sql FROM sqlite_schema WHERE name = ?", name!);
      if (!row || typeof row.sql !== "string" || normalize(row.sql) !== normalize(expected!))
        throw new HostError("conflict", "Client enrollment schema is not canonical.");
    }
  }
  private assertClientAuthority(hostId: string, ownerId: string): void {
    const canonicalHost = this.one("SELECT value FROM meta WHERE key = 'host_id'");
    const canonicalOwner = this.one("SELECT value FROM meta WHERE key = 'owner_id'");
    if (canonicalHost?.value !== hostId || canonicalOwner?.value !== ownerId)
      throw new HostError("conflict", "Client enrollment authority is inconsistent.");
  }
  private clientEnrollment(row: Row, hostId: string, ownerId: string): ClientDeviceEnrollment {
    try {
      this.assertClientAuthority(hostId, ownerId);
      if (row.host_id !== hostId || row.owner_id !== ownerId
        || row.host_key !== "host_id" || row.owner_key !== "owner_id") throw new Error();
      const scopes: unknown = JSON.parse(str(row, "scopes"));
      const claim = clientClaimInput({ namespace: row.namespace, claimId: row.claim_id, name: row.original_name,
        fingerprint: row.fingerprint, role: row.role, scopes });
      if (claim.name !== row.original_name || JSON.stringify(claim.scopes) !== row.scopes
        || row.digest !== clientDigest(claim, hostId, ownerId) || !Number.isSafeInteger(row.created_at) || num(row, "created_at") < 0) throw new Error();
      const deviceRow = this.one("SELECT * FROM devices WHERE id = ? AND owner_id = ?", str(row, "device_id"), ownerId);
      if (!deviceRow || deviceRow.platform !== (claim.role === "client-ios" ? "ios" : "macos") || deviceRow.capabilities !== "[]"
        || deviceRow.created_at !== row.created_at) throw new Error();
      const device = parse(DeviceInputSchema, { name: deviceRow.name, platform: deviceRow.platform, capabilities: [] });
      if (device.name !== deviceRow.name || !Number.isSafeInteger(deviceRow.last_seen_at) || num(deviceRow, "last_seen_at") < 0
        || (deviceRow.revoked_at !== null && (!Number.isSafeInteger(deviceRow.revoked_at) || num(deviceRow, "revoked_at") < 0))) throw new Error();
      return { namespace: claim.namespace, claimId: claim.claimId, hostId, ownerId, deviceId: str(row, "device_id"),
        originalName: claim.name, fingerprint: claim.fingerprint, role: claim.role, scopes: Object.freeze([...claim.scopes]),
        digest: str(row, "digest"), createdAt: num(row, "created_at"), device: toDevice(deviceRow) };
    } catch { throw new HostError("conflict", "Client enrollment metadata is inconsistent."); }
  }

  private openInTransaction(requestedOwner: string | undefined): { hostId: string; ownerId: string } {
    const version = num(this.db.prepare("PRAGMA user_version").get() as Row, "user_version");
    if (!Number.isSafeInteger(version) || version < 0) throw new HostError("conflict", "Invalid database schema version.");
    if (version === 0 && this.one("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))
      throw new HostError("conflict", "Unversioned database is not empty.");
    if (version > SCHEMA_VERSION) throw new HostError("conflict", `database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    // Forward-only, inside the open transaction: a failed migration rolls back and leaves the old schema intact.
    for (let next = version; next < SCHEMA_VERSION; next += 1) this.db.exec(MIGRATIONS[next]!);
    if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    const meta = (key: string): string | null => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
      return row ? str(row, "value") : null;
    };
    const setMeta = (key: string, value: string): void => { this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, value); };
    if (version > 0 && (!meta("host_id") || !meta("owner_id"))) throw new HostError("conflict", "Existing host authority is missing.");
    let hostId = meta("host_id");
    if (hostId === null) { hostId = newId("host"); setMeta("host_id", hostId); }
    let ownerId = meta("owner_id");
    if (ownerId === null) { ownerId = requestedOwner ?? newId("own"); setMeta("owner_id", ownerId); }
    if (requestedOwner !== undefined && requestedOwner !== ownerId) throw new HostError("forbidden", "data directory belongs to another owner");

    this.validateClientEnrollmentSchema();
    if (this.one("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name NOT IN ('client_enrollment_no_update', 'client_enrollment_no_delete')"))
      throw new HostError("conflict", "Imported triggers are not canonical.");
    if (this.db.prepare("PRAGMA foreign_key_check(client_device_enrollments)").all().length)
      throw new HostError("conflict", "Client enrollment references are inconsistent.");
    for (const row of this.all("SELECT * FROM client_device_enrollments")) this.clientEnrollment(row, hostId, ownerId);

    const lease = this.db.prepare("SELECT * FROM host_lease WHERE id = 1").get() as Row | undefined;
    if (lease) {
      const sameHost = str(lease, "hostname") === hostname();
      const pid = num(lease, "pid");
      if (!sameHost) throw new HostError("host_locked", "data directory is leased by another host; transfer authority explicitly");
      if (pid === process.pid || pidAlive(pid)) throw new HostError("host_locked", "data directory is leased by a running process");
    }
    this.db.prepare(`INSERT INTO host_lease (id, hostname, pid, token, acquired_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET hostname = excluded.hostname, pid = excluded.pid, token = excluded.token, acquired_at = excluded.acquired_at`)
      .run(hostname(), process.pid, this.leaseToken, this.clock());
    // Nothing can be running without a live writer: whatever was started before is an unknown outcome.
    const interrupted = this.db.prepare("SELECT id, bot_id, thread_id FROM actions WHERE state = 'running'").all() as Row[];
    const now = this.clock();
    for (const row of interrupted) {
      this.db.prepare("UPDATE actions SET state = 'unknown', reason = 'host_interrupted', updated_at = ? WHERE id = ?").run(now, str(row, "id"));
      this.emitRaw("action.unknown", str(row, "bot_id"), str(row, "thread_id"), str(row, "id"), now);
    }
    // Same for turns: the engine may or may not have run inference. Never re-sent automatically.
    // Queued turns never reached a driver and stay queued until explicitly resumed or cancelled.
    for (const row of this.db.prepare("SELECT id, thread_id FROM turns WHERE state = 'running'").all() as Row[]) {
      this.db.prepare("UPDATE turns SET state = 'unknown', code = 'host_interrupted', finished_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, str(row, "id"));
      this.turnEvent(str(row, "id"), str(row, "thread_id"), "turn.unknown", null, { code: "host_interrupted" }, now);
    }
    return { hostId, ownerId };
  }

  private immediate<T>(fn: () => T | CommitThenThrow): T {
    this.db.exec("BEGIN IMMEDIATE");
    let result: T | CommitThenThrow;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    if (result instanceof CommitThenThrow) throw result.error;
    return result;
  }
  /** Write transaction fenced by the lease token: a store that lost its lease cannot write. */
  private write<T>(fn: () => T | CommitThenThrow): T {
    if (this.closed) throw new HostError("host_locked", "store is closed");
    return this.immediate(() => {
      const lease = this.db.prepare("SELECT token FROM host_lease WHERE id = 1").get() as Row | undefined;
      if (!lease || str(lease, "token") !== this.leaseToken) throw new HostError("host_locked", "host lease is no longer held");
      return fn();
    });
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    if (this.closed) throw new HostError("host_locked", "store is closed");
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    if (this.closed) throw new HostError("host_locked", "store is closed");
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private emit(kind: EventKind, botId: string | null, threadId: string | null, entityId: string): void {
    this.emitRaw(kind, botId, threadId, entityId, this.clock());
  }
  private emitRaw(kind: EventKind, botId: string | null, threadId: string | null, entityId: string, now: number): void {
    this.db.prepare("INSERT INTO events (id, kind, bot_id, thread_id, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId("evt"), kind, botId, threadId, entityId, now);
  }
  private transition(id: string, state: ActionState, reason: ActionReason | null, event: EventKind, decidedBy?: string): Action {
    const now = this.clock();
    if (decidedBy === undefined) {
      this.db.prepare("UPDATE actions SET state = ?, reason = ?, updated_at = ? WHERE id = ?").run(state, reason, now, id);
    } else {
      this.db.prepare("UPDATE actions SET state = ?, reason = ?, decided_by = ?, updated_at = ? WHERE id = ?").run(state, reason, decidedBy, now, id);
    }
    const action = this.getAction(id);
    this.emitRaw(event, action.request.botId, action.request.threadId, id, now);
    return action;
  }
  private insertMessage(threadId: string, botId: string, clientMessageId: string, role: Message["role"], content: string, now: number): string {
    const id = newId("msg");
    this.db.prepare("INSERT INTO messages (id, thread_id, client_message_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, threadId, clientMessageId, role, content, now);
    this.emitRaw("message.appended", botId, threadId, id, now);
    return id;
  }
  private turnEvent(turnId: string, threadId: string, kind: TurnEventKind, text: string | null, data: JsonValue | null, now: number): void {
    this.db.prepare("INSERT INTO turn_events (turn_id, thread_id, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(turnId, threadId, kind, text, data === null ? null : canonicalJson(data), now);
  }
  private grantRow(botId: string, tool: string, destination: string): Row | undefined {
    return this.one("SELECT * FROM grants WHERE bot_id = ? AND tool = ? AND destination = ?", botId, tool, destination);
  }
  private effectiveGrant(botId: string, tool: string, destination: string, now: number): Grant | null {
    const row = this.grantRow(botId, tool, destination);
    if (!row) return null;
    const grant = toGrant(row);
    if (grant.policy === "deny" || (grant.expiresAt !== null && now >= grant.expiresAt)) return null;
    return grant;
  }
  private grantStillValid(action: Action, now: number): boolean {
    const grant = this.effectiveGrant(action.request.botId, action.request.tool, action.request.destination, now);
    return grant !== null && grant.revision === action.grantRevision;
  }
  private deviceRow(id: string): Row {
    const row = this.one("SELECT * FROM devices WHERE id = ? AND owner_id = ?", id, this.ownerId);
    if (!row) throw new HostError("not_found", "device not found");
    return row;
  }
}

function cursorArg(after: number): number {
  if (!Number.isSafeInteger(after) || after < 0) throw new HostError("invalid_input", "after: invalid_value");
  return after;
}
function pageArg(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new HostError("invalid_input", "limit: invalid_value");
  return Math.min(limit, MAX_PAGE);
}
function presenceOf(row: Row, now: number, ttlMs: number): DevicePresence {
  if (nnum(row, "revoked_at") !== null) return "revoked";
  return now - num(row, "last_seen_at") < ttlMs ? "online" : "stale";
}
function toBot(row: Row): Bot {
  return {
    id: str(row, "id"), ownerId: str(row, "owner_id"), profileId: str(row, "profile_id"), name: str(row, "name"),
    engine: str(row, "engine") as Bot["engine"], createdAt: num(row, "created_at"),
  };
}
function toMessage(row: Row): Message {
  return {
    cursor: num(row, "cursor"), id: str(row, "id"), threadId: str(row, "thread_id"), clientMessageId: str(row, "client_message_id"),
    role: str(row, "role") as Message["role"], content: str(row, "content"), createdAt: num(row, "created_at"),
  };
}
function toGrant(row: Row): Grant {
  return {
    botId: str(row, "bot_id"), tool: str(row, "tool"), destination: str(row, "destination"),
    policy: str(row, "policy") as Grant["policy"], expiresAt: nnum(row, "expires_at"), revision: num(row, "revision"),
  };
}
function toAction(row: Row): Action {
  const result = nstr(row, "result");
  return {
    id: str(row, "id"), request: JSON.parse(str(row, "request")) as ToolRequest, requestHash: str(row, "request_hash"),
    grantRevision: num(row, "grant_revision"), state: str(row, "state") as ActionState,
    createdAt: num(row, "created_at"), updatedAt: num(row, "updated_at"), approvalExpiresAt: nnum(row, "approval_expires_at"),
    decidedBy: nstr(row, "decided_by"), result: result === null ? null : (JSON.parse(result) as JsonValue),
    reason: nstr(row, "reason") as Action["reason"],
  };
}
function toDevice(row: Row): Device {
  return {
    id: str(row, "id"), ownerId: str(row, "owner_id"), name: str(row, "name"), platform: str(row, "platform") as Device["platform"],
    capabilities: JSON.parse(str(row, "capabilities")) as string[], lastSeenAt: num(row, "last_seen_at"), revokedAt: nnum(row, "revoked_at"),
  };
}
function toTurn(row: Row): Turn {
  return {
    cursor: num(row, "cursor"), id: str(row, "id"), threadId: str(row, "thread_id"), botId: str(row, "bot_id"),
    engine: str(row, "engine") as Turn["engine"], clientRequestId: str(row, "client_request_id"),
    inputMessageId: str(row, "input_message_id"), outputMessageId: nstr(row, "output_message_id"),
    state: str(row, "state") as TurnState, code: nstr(row, "code") as TurnCode | null,
    outputChars: num(row, "output_chars"), outputTruncated: num(row, "output_truncated") === 1,
    createdAt: num(row, "created_at"), startedAt: nnum(row, "started_at"), finishedAt: nnum(row, "finished_at"), updatedAt: num(row, "updated_at"),
  };
}
function toTurnEvent(row: Row): TurnEvent {
  const data = nstr(row, "data");
  return {
    cursor: num(row, "cursor"), turnId: str(row, "turn_id"), threadId: str(row, "thread_id"), kind: str(row, "kind") as TurnEventKind,
    text: nstr(row, "text"), data: data === null ? null : (JSON.parse(data) as JsonValue), createdAt: num(row, "created_at"),
  };
}
