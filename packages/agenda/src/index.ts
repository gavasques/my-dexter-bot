import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AutomationWhenSchema, AutomationCreateSchema, AutomationUpdateSchema, AutomationStateSchema, AutomationRunSchema, AutomationListSchema, AutomationHistorySchema, AutomationCalendarSchema, AutomationPreviewSchema, type AutomationWhen, AppendMessageSchema, IdSchema, StartTurnSchema } from "@dexter/contracts";
import { Cron } from "croner";
import { HostError, type HostStore, type StartedTurn } from "@dexter/hub";

export const AGENDA_DATABASE_FILE = "agenda.sqlite";
export const AGENDA_SCHEMA_VERSION = 3;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 30 * 24 * 60 * 60_000;
export const MAX_SCHEDULES = 10_000;
export const MAX_SCHEDULES_PER_TICK = 100;
export const MAX_DISPATCHES_PER_TICK = 100;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_RETENTION_BATCH = 100;
export const MAX_RETENTION_BATCH = 500;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_CONTENT_CHARS = 32_768;

export type AgendaWhen = AutomationWhen;
export interface CreateScheduleInput { botId: string; threadId: string; content: string; when: AgendaWhen; title?:string }
export type AgendaScheduleState = "active" | "disabled" | "completed";
export interface AgendaSchedule {
  id: string;
  ownerId: string;
  installationId: string;
  botId: string;
  threadId: string;
  kind: AgendaWhen["kind"];
  at: number | null;
  intervalMs: number | null;
  nextAt: number | null;
  content: string;
  title:string;
  cron:string|null;
  timeZone:string|null;
  state: AgendaScheduleState;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface AgendaScheduleCursor { createdAt: number; id: string }
export interface AgendaOccurrenceCursor { scheduleId: string; scheduledAt: number }
export interface AgendaScheduleListOptions { limit?: number; after?: AgendaScheduleCursor }
export interface AgendaOccurrenceListOptions { scheduleId?: string; limit?: number; after?: AgendaOccurrenceCursor }
export interface AgendaPage<T, Cursor> { items: T[]; nextCursor: Cursor | null }
export interface AgendaRetentionOptions { beforeUpdatedAt: number; limit?: number }
export interface AgendaRetentionReport { deleted: number; truncated: boolean }
export type AgendaOccurrenceState = "prepared" | "accepted" | "withdrawn" | "blocked";
export interface AgendaOccurrence {
  scheduleId: string;
  scheduledAt: number;
  scheduleRevision: number;
  clientRequestId: string;
  source:"scheduled"|"manual";
  state: AgendaOccurrenceState;
  turnId: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}
export interface AgendaMutationReceipt {id:string;hostId:string;clientRequestId:string;operation:"create"|"update"|"state"|"run";scheduleId:string;revision:number;createdAt:number;replayed:boolean;schedule:AgendaSchedule;occurrence?:AgendaOccurrence}
export interface AgendaHistoryItem extends AgendaOccurrence {botId:string;threadId:string;title:string;turnState:string|null;turnCode:string|null}
export interface AgendaCalendarItem {scheduleId:string;botId:string;threadId:string;title:string;scheduledAt:number;source:"projected"|"scheduled"|"manual";occurrenceState?:AgendaOccurrenceState;turnId?:string|null;turnState?:string|null;turnCode?:string|null}
export interface AgendaPreparation {
  prepared: number;
  pending: number;
  truncated: boolean;
}
export type AgendaAttemptState = "accepted" | "replayed" | "deferred" | "withdrawn" | "blocked" | "already_handled";
export interface AgendaAttempt {
  scheduleId: string;
  scheduledAt: number;
  state: AgendaAttemptState;
  turnId: string | null;
}
export interface AgendaDispatchReport {
  attempted: number;
  accepted: number;
  replayed: number;
  deferred: number;
  withdrawn: number;
  blocked: number;
  pending: number;
  truncated: boolean;
  attempts: AgendaAttempt[];
}
export interface AgendaTickReport extends AgendaPreparation, AgendaDispatchReport {}

export interface AgendaRuntime {
  startTurn(threadId: string, input: { clientRequestId: string; content: string }): StartedTurn;
}
export interface AgendaOptions {
  /** Epoch milliseconds. Defaults to the HostStore clock. */
  clock?: () => number;
  /** Bounds due occurrences considered by each explicit tick; 1...100. */
  maxSchedulesPerTick?: number;
  /** Bounds pending intents dispatched by each explicit tick; 1...100. */
  maxDispatchesPerTick?: number;
}

type Row = Record<string, unknown>;
export const AGENDA_V3_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('once', 'interval', 'cron')),
  at INTEGER,
  interval_ms INTEGER,
  next_at INTEGER,
  content TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'completed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_occurrence_at INTEGER,
  title TEXT NOT NULL,
  cron TEXT,
  time_zone TEXT,
  CHECK ((kind = 'once' AND at IS NOT NULL AND interval_ms IS NULL) OR
         (kind = 'interval' AND at IS NULL AND interval_ms IS NOT NULL) OR
         (kind = 'cron' AND at IS NULL AND interval_ms IS NULL AND cron IS NOT NULL AND time_zone IS NOT NULL))
) STRICT;
CREATE INDEX schedules_due ON schedules (state, next_at, id);
CREATE INDEX schedules_page ON schedules (created_at, id);
CREATE TABLE occurrences (
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  scheduled_at INTEGER NOT NULL,
  schedule_revision INTEGER NOT NULL CHECK (schedule_revision > 0),
  client_request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'withdrawn', 'blocked')),
  turn_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'scheduled' CHECK (source IN ('scheduled','manual')),
  PRIMARY KEY (schedule_id, scheduled_at),
  CHECK ((state = 'accepted' AND turn_id IS NOT NULL) OR state <> 'accepted')
) STRICT;
CREATE INDEX occurrences_pending ON occurrences (state, attempts, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_terminal ON occurrences (state, updated_at, schedule_id, scheduled_at);
CREATE INDEX occurrences_schedule_state ON occurrences (schedule_id, state);
CREATE TABLE receipts (
  client_request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`;

const str = (row: Row, key: string): string => row[key] as string;
const num = (row: Row, key: string): number => Number(row[key]);
const maybeNum = (row: Row, key: string): number | null => row[key] === null ? null : Number(row[key]);
const maybeStr = (row: Row, key: string): string | null => row[key] === null ? null : String(row[key]);

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Reject symlinks and non-regular SQLite files, including WAL/SHM sidecars. */
function checkFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let stat;
    try { stat = lstatSync(`${databasePath}${suffix}`); }
    catch (error) { if (isMissing(error)) continue; throw new HostError("conflict", "agenda database path is unavailable"); }
    if (stat.isSymbolicLink() || !stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
      throw new HostError("conflict", "agenda database file is not trusted");
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(`${databasePath}${suffix}`, 0o600);
  }
}

function scheduleFrom(row: Row): AgendaSchedule {
  return {
    id: str(row, "id"), ownerId: str(row, "owner_id"), installationId: str(row, "installation_id"),
    botId: str(row, "bot_id"), threadId: str(row, "thread_id"), kind: str(row, "kind") as AgendaSchedule["kind"],
    at: maybeNum(row, "at"), intervalMs: maybeNum(row, "interval_ms"), nextAt: maybeNum(row, "next_at"),
    title:str(row,"title"),cron:maybeStr(row,"cron"),timeZone:maybeStr(row,"time_zone"),
    content: str(row, "content"), state: str(row, "state") as AgendaScheduleState,
    revision: num(row, "revision"), createdAt: num(row, "created_at"), updatedAt: num(row, "updated_at"),
  };
}

function occurrenceFrom(row: Row): AgendaOccurrence {
  return {
    scheduleId: str(row, "schedule_id"), scheduledAt: num(row, "scheduled_at"),
    scheduleRevision: num(row, "schedule_revision"), clientRequestId: str(row, "client_request_id"),
    source:str(row,"source") as "scheduled"|"manual",
    state: str(row, "state") as AgendaOccurrenceState, turnId: maybeStr(row, "turn_id"),
    attempts: num(row, "attempts"), createdAt: num(row, "created_at"), updatedAt: num(row, "updated_at"),
  };
}

function requestId(scheduleId: string, scheduledAt: number): string {
  const hash = createHash("sha256").update(`${scheduleId}\n${scheduledAt}`).digest("hex");
  return `agenda_${hash}`;
}

function parseTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new HostError("invalid_input", "agenda timestamp must be UTC epoch milliseconds");
  }
  return value;
}

function parseLimit(value: unknown, fallback: number, maximum: number, message: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new HostError("invalid_input", message);
  }
  return value;
}

function scheduleListArgs(options: unknown): { limit: number; after?: AgendaScheduleCursor } {
  const record = closedRecord(options, ["limit", "after"]);
  if (!record) throw new HostError("invalid_input", "agenda schedule page options are invalid");
  const limit = parseLimit(record.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, "agenda page limit is invalid");
  if (record.after === undefined) return { limit };
  const cursor = strictRecord(record.after, ["createdAt", "id"]);
  if (!cursor || typeof cursor.createdAt !== "number" || !IdSchema.safeParse(cursor.id).success) {
    throw new HostError("invalid_input", "agenda schedule cursor is invalid");
  }
  return { limit, after: { createdAt: parseTimestamp(cursor.createdAt), id: String(cursor.id) } };
}

function occurrenceListArgs(options: unknown): { limit: number; scheduleId?: string; after?: AgendaOccurrenceCursor } {
  const record = closedRecord(options, ["scheduleId", "limit", "after"]);
  if (!record) throw new HostError("invalid_input", "agenda occurrence page options are invalid");
  if (record.scheduleId !== undefined && !IdSchema.safeParse(record.scheduleId).success) {
    throw new HostError("invalid_input", "agenda schedule id is invalid");
  }
  const limit = parseLimit(record.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, "agenda page limit is invalid");
  if (record.after === undefined) {
    return { limit, ...(record.scheduleId === undefined ? {} : { scheduleId: String(record.scheduleId) }) };
  }
  const cursor = strictRecord(record.after, ["scheduleId", "scheduledAt"]);
  if (!cursor || !IdSchema.safeParse(cursor.scheduleId).success || typeof cursor.scheduledAt !== "number") {
    throw new HostError("invalid_input", "agenda occurrence cursor is invalid");
  }
  const after = { scheduleId: String(cursor.scheduleId), scheduledAt: parseTimestamp(cursor.scheduledAt) };
  if (record.scheduleId !== undefined && record.scheduleId !== after.scheduleId) {
    throw new HostError("invalid_input", "agenda occurrence cursor does not match the schedule filter");
  }
  return { limit, after, ...(record.scheduleId === undefined ? {} : { scheduleId: String(record.scheduleId) }) };
}

function retentionArgs(options: unknown): { beforeUpdatedAt: number; limit: number } {
  const record = closedRecord(options, ["beforeUpdatedAt", "limit"]);
  if (!record || typeof record.beforeUpdatedAt !== "number") {
    throw new HostError("invalid_input", "agenda retention options are invalid");
  }
  return {
    beforeUpdatedAt: parseTimestamp(record.beforeUpdatedAt),
    limit: parseLimit(record.limit, DEFAULT_RETENTION_BATCH, MAX_RETENTION_BATCH, "agenda retention limit is invalid"),
  };
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).length !== keys.length
    || Reflect.ownKeys(record).some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return !descriptor || !("value" in descriptor);
    })) return null;
  return record;
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => {
    if (typeof key !== "string" || !keys.includes(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return !descriptor || !("value" in descriptor);
  })) return null;
  return record;
}

export function validateAutomationWhen(input:unknown):AgendaWhen {
  const parsed=AutomationWhenSchema.safeParse(input);
  if(!parsed.success)throw new HostError("invalid_input","Automation recurrence is invalid.");
  const when=parsed.data;
  if(when.kind==="cron"){
    if(when.expression.trim().split(/\s+/).length!==5 || !/^[0-9*,/ -]+$/.test(when.expression))throw new HostError("invalid_input","Use a five-field numeric cron expression.");
    if(!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(when.timeZone))throw new HostError("invalid_input","Use an IANA time zone name.");
    try { new Intl.DateTimeFormat("en",{timeZone:when.timeZone}).format(0); const cron=new Cron(when.expression,{timezone:when.timeZone,mode:"5-part"}); cron.nextRun(new Date(0));cron.stop(); }
    catch { throw new HostError("invalid_input","Cron expression or IANA time zone is invalid."); }
  }
  return when;
}
/** Pure recurrence calculation. Croner is created without a callback and never owns a timer. */
export function nextAutomationAt(when:AgendaWhen,after:number):number|null {
  parseTimestamp(after);
  if(when.kind==="once")return when.at>after?when.at:null;
  if(when.kind==="interval"){
    const date=when.firstAt>after?when.firstAt:when.firstAt+(Math.floor((after-when.firstAt)/when.everyMs)+1)*when.everyMs;
    return Number.isSafeInteger(date)&&date<=MAX_TIMESTAMP?date:null;
  }
  const cron=new Cron(when.expression,{timezone:when.timeZone,mode:"5-part"});
  try { return cron.nextRun(new Date(after))?.getTime()??null; } finally { cron.stop(); }
}
function latestCronAt(when:AgendaWhen,now:number,fallback:number):number {
  if(when.kind!=="cron")return fallback;
  const cron=new Cron(when.expression,{timezone:when.timeZone,mode:"5-part"});
  try {return cron.previousRuns(1,new Date(now+1))[0]?.getTime()??fallback;}finally{cron.stop();}
}
function scheduleWhen(schedule:AgendaSchedule):AgendaWhen {
  if(schedule.kind==="once")return {kind:"once",at:schedule.at!};
  if(schedule.kind==="interval")return {kind:"interval",everyMs:schedule.intervalMs!,firstAt:schedule.nextAt??schedule.createdAt};
  return {kind:"cron",expression:schedule.cron!,timeZone:schedule.timeZone!};
}
function parseScheduleInput(input:unknown):CreateScheduleInput|null {
  const outer=closedRecord(input,["botId","threadId","content","when","title"]);
  if(!outer||!IdSchema.safeParse(outer.botId).success||!IdSchema.safeParse(outer.threadId).success||typeof outer.content!=="string"||!AppendMessageSchema.shape.content.safeParse(outer.content).success||outer.content.length>MAX_CONTENT_CHARS)return null;
  if(outer.title!==undefined&&(typeof outer.title!=="string"||!outer.title.trim()||outer.title.length>160))return null;
  try{return {botId:String(outer.botId),threadId:String(outer.threadId),content:outer.content,when:validateAutomationWhen(outer.when),title:typeof outer.title==="string"?outer.title.trim():"Automação"};}catch{return null;}
}

/**
 * Durable local schedule library. It never creates a timer or calls an engine: the trusted host calls `tick`
 * explicitly and supplies its existing ConversationRuntime. Agenda records the due intent before startTurn,
 * then reuses a deterministic clientRequestId until HostStore confirms the accepted turn.
 */
export class Agenda {
  readonly databasePath: string;
  readonly #store: HostStore;
  readonly #clock: () => number;
  readonly #maxSchedules: number;
  readonly #maxDispatches: number;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(store: HostStore, options: AgendaOptions = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => store.now());
    this.#maxSchedules = options.maxSchedulesPerTick ?? MAX_SCHEDULES_PER_TICK;
    this.#maxDispatches = options.maxDispatchesPerTick ?? MAX_DISPATCHES_PER_TICK;
    if (!Number.isInteger(this.#maxSchedules) || this.#maxSchedules < 1 || this.#maxSchedules > MAX_SCHEDULES_PER_TICK
      || !Number.isInteger(this.#maxDispatches) || this.#maxDispatches < 1 || this.#maxDispatches > MAX_DISPATCHES_PER_TICK) {
      throw new HostError("invalid_input", "agenda tick limits are invalid");
    }
    this.databasePath = join(dirname(store.databasePath), AGENDA_DATABASE_FILE);
    this.#db = store.withWriterLease(() => this.#open());
  }

  #open(): DatabaseSync {
    checkFiles(this.databasePath);
    const db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
    try {
      chmodSync(this.databasePath, 0o600);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      const journal = db.prepare("PRAGMA journal_mode").get() as Row;
      if (String(journal.journal_mode).toLowerCase() !== "wal") throw new HostError("conflict", "agenda database could not enter WAL mode");
      checkFiles(this.databasePath);
      const version = num(db.prepare("PRAGMA user_version").get() as Row, "user_version");
      if (version !== 0 && version !== 1 && version !== 2 && version !== AGENDA_SCHEMA_VERSION) throw new HostError("conflict", "agenda schema version is unsupported");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (version === 0) {
          db.exec(AGENDA_V3_SCHEMA);
          const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
          put.run("schema_version", String(AGENDA_SCHEMA_VERSION));
          put.run("installation_id", this.#store.hostId);
          put.run("owner_id", this.#store.ownerId);
          db.exec(`PRAGMA user_version = ${AGENDA_SCHEMA_VERSION}`);
        } else if (version === 1) {
          const get = (key: string): string | undefined => {
            const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
            return row ? String(row.value) : undefined;
          };
          if (get("schema_version") !== "1" || get("installation_id") !== this.#store.hostId || get("owner_id") !== this.#store.ownerId) {
            throw new HostError("conflict", "agenda database belongs to another installation or owner");
          }
          db.exec(`ALTER TABLE schedules ADD COLUMN last_occurrence_at INTEGER;
            UPDATE schedules SET last_occurrence_at = (
              SELECT MAX(scheduled_at) FROM occurrences WHERE occurrences.schedule_id = schedules.id
            ) WHERE EXISTS (SELECT 1 FROM occurrences WHERE occurrences.schedule_id = schedules.id);
            DROP INDEX IF EXISTS occurrences_pending;
            CREATE INDEX occurrences_pending ON occurrences (state, attempts, updated_at, schedule_id, scheduled_at);
            CREATE INDEX IF NOT EXISTS occurrences_terminal ON occurrences (state, updated_at, schedule_id, scheduled_at);
            CREATE INDEX IF NOT EXISTS occurrences_schedule_state ON occurrences (schedule_id, state);
            CREATE INDEX IF NOT EXISTS schedules_page ON schedules (created_at, id);
            UPDATE meta SET value = '2' WHERE key = 'schema_version';
            PRAGMA user_version = 2;`);
        }
        if(version===1||version===2){
          const meta=(key:string)=>(db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row|undefined)?.value;
          if(meta("schema_version")!=="2"||meta("installation_id")!==this.#store.hostId||meta("owner_id")!==this.#store.ownerId)throw new HostError("conflict","Agenda migration identity is invalid.");
          db.exec(`CREATE TEMP TABLE migration_schedules AS SELECT * FROM schedules;
            CREATE TEMP TABLE migration_occurrences AS SELECT * FROM occurrences;
            DROP TABLE occurrences; DROP TABLE schedules; DROP TABLE meta;`);
          db.exec(AGENDA_V3_SCHEMA);
          const put=db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
          put.run("schema_version","3");put.run("owner_id",this.#store.ownerId);put.run("installation_id",this.#store.hostId);
          db.exec(`INSERT INTO schedules(id,owner_id,installation_id,bot_id,thread_id,kind,at,interval_ms,next_at,content,state,revision,created_at,updated_at,last_occurrence_at,title,cron,time_zone)
            SELECT id,owner_id,installation_id,bot_id,thread_id,kind,at,interval_ms,next_at,content,state,revision,created_at,updated_at,last_occurrence_at,'Automação',NULL,NULL FROM migration_schedules;
            INSERT INTO occurrences(schedule_id,scheduled_at,schedule_revision,client_request_id,state,turn_id,attempts,created_at,updated_at,source)
            SELECT schedule_id,scheduled_at,schedule_revision,client_request_id,state,turn_id,attempts,created_at,updated_at,'scheduled' FROM migration_occurrences;
            DROP TABLE migration_occurrences; DROP TABLE migration_schedules; PRAGMA user_version=3;`);
        }
        this.#checkMeta(db);
        checkFiles(this.databasePath);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
      checkFiles(this.databasePath);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #checkOpen(): void {
    if (this.#closed) throw new HostError("host_locked", "agenda is closed");
  }

  #checkMeta(db = this.#db): void {
    const get = (key: string): string | undefined => {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
      return row ? String(row.value) : undefined;
    };
    if (get("schema_version") !== String(AGENDA_SCHEMA_VERSION)
      || get("installation_id") !== this.#store.hostId || get("owner_id") !== this.#store.ownerId) {
      throw new HostError("conflict", "agenda database belongs to another installation or owner");
    }
    const version = num(db.prepare("PRAGMA user_version").get() as Row, "user_version");
    if (version !== AGENDA_SCHEMA_VERSION) throw new HostError("conflict", "agenda schema version is unsupported");
  }

  /** Synchronous metadata transaction under the canonical HostStore lease. Never calls HostStore writes. */
  #fenced<T>(operation: () => T): T {
    this.#checkOpen();
    return this.#store.withWriterLease(() => {
      checkFiles(this.databasePath);
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#checkMeta();
        const result = operation();
        checkFiles(this.databasePath);
        this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  create(input: CreateScheduleInput): AgendaSchedule {
    const data = parseScheduleInput(input);
    if (!data) throw new HostError("invalid_input", "agenda schedule input is invalid");
    const now = parseTimestamp(this.#clock());
    return this.#fenced(()=>this.#create(data,now));
  }
  #create(data:CreateScheduleInput,now:number):AgendaSchedule {
      const thread = this.#store.getThread(data.threadId);
      const bot = this.#store.getBot(data.botId);
      if (thread.botId !== bot.id || bot.ownerId !== this.#store.ownerId) throw new HostError("forbidden", "agenda thread does not belong to this bot owner");
      const count = num(this.#db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as Row, "n");
      if (count >= MAX_SCHEDULES) throw new HostError("conflict", "agenda schedule limit reached");
      const id = `ag_${randomUUID()}`;
      const at = data.when.kind === "once" ? data.when.at : null;
      const intervalMs = data.when.kind === "interval" ? data.when.everyMs : null;
      const nextAt = data.when.kind === "once" ? data.when.at : data.when.kind==="interval"?data.when.firstAt:nextAutomationAt(data.when,now);
      const cron=data.when.kind==="cron"?data.when.expression:null,timeZone=data.when.kind==="cron"?data.when.timeZone:null;
      this.#db.prepare(`INSERT INTO schedules
        (id, owner_id, installation_id, bot_id, thread_id, kind, at, interval_ms, next_at, content, state, revision, created_at, updated_at,title,cron,time_zone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?,?,?,?)`)
        .run(id, this.#store.ownerId, this.#store.hostId, bot.id, thread.id, data.when.kind, at, intervalMs, nextAt, data.content, now, now,data.title??"Automação",cron,timeZone);
      return scheduleFrom(this.#db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row);
  }

  #host(input:{hostId:string}):void {
    if(input.hostId!==this.#store.hostId)throw new HostError("conflict","Automation host identity changed.");
  }
  #row(id:string):Row {
    if(!IdSchema.safeParse(id).success)throw new HostError("invalid_input","Automation identifier is invalid.");
    const row=this.#db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as Row|undefined;
    if(!row)throw new HostError("not_found","Automation not found.");
    const bot=this.#store.getBot(str(row,"bot_id")),thread=this.#store.getThread(str(row,"thread_id"));
    if(bot.ownerId!==this.#store.ownerId||thread.botId!==bot.id||str(row,"owner_id")!==this.#store.ownerId||str(row,"installation_id")!==this.#store.hostId)throw new HostError("forbidden","Automation ownership is invalid.");
    return row;
  }
  get(id:string):AgendaSchedule { return this.#fenced(()=>scheduleFrom(this.#row(id))); }
  /** Accepted is dispatch acceptance only. Hub turns remain the canonical execution status. */
  #history(row:Row):AgendaHistoryItem {
    const schedule=scheduleFrom(this.#row(str(row,"schedule_id"))),occurrence=occurrenceFrom(row);
    const turn=occurrence.turnId?this.#store.getTurn(occurrence.turnId):this.#store.findTurn(schedule.threadId,occurrence.clientRequestId);
    if(turn&&(turn.threadId!==schedule.threadId||turn.botId!==schedule.botId))throw new HostError("conflict","Automation turn identity is invalid.");
    return {...occurrence,botId:schedule.botId,threadId:schedule.threadId,title:schedule.title,turnId:turn?.id??occurrence.turnId,turnState:turn?.state??null,turnCode:turn?.code??null};
  }
  #overlap(id:string,ignorePrepared=false):boolean {
    const rows=this.#db.prepare("SELECT * FROM occurrences WHERE schedule_id=? AND state IN ('prepared','accepted') ORDER BY scheduled_at DESC").all(id) as Row[];
    const schedule=scheduleFrom(this.#row(id));
    if(this.#store.hasUnsettledThreadActions(schedule.threadId))return true;
    for(const row of rows){
      if(str(row,"state")==="prepared"){if(!ignorePrepared)return true;continue;}
      const turn=this.#store.getTurn(str(row,"turn_id"));
      if(turn.botId!==schedule.botId||turn.threadId!==schedule.threadId)throw new HostError("conflict","Automation turn identity is invalid.");
      if(["queued","running"].includes(turn.state)||this.#store.hasUnreconciledTurn(turn.id))return true;
    }
    return false;
  }
  #mutation(operation:AgendaMutationReceipt["operation"],input:{hostId:string;clientRequestId:string;expectedRevision:number},id:string|null,work:()=>{schedule:AgendaSchedule;occurrence?:AgendaOccurrence}):AgendaMutationReceipt {
    this.#host(input);
    const hash=createHash("sha256").update(JSON.stringify({operation,id,input})).digest("hex");
    return this.#fenced(()=>{
      const previous=this.#db.prepare("SELECT request_hash,receipt_json FROM receipts WHERE client_request_id=?").get(input.clientRequestId) as Row|undefined;
      if(previous){
        if(str(previous,"request_hash")!==hash)throw new HostError("conflict","Automation request identifier was already used for different input.");
        return {...JSON.parse(str(previous,"receipt_json")) as AgendaMutationReceipt,replayed:true};
      }
      if(id!==null&&num(this.#row(id),"revision")!==input.expectedRevision)throw new HostError("conflict","Automation revision changed. Reload before retrying.");
      const now=parseTimestamp(this.#clock()),result=work();
      const receipt:AgendaMutationReceipt={id:`ar_${randomUUID()}`,hostId:this.#store.hostId,clientRequestId:input.clientRequestId,operation,scheduleId:result.schedule.id,revision:result.schedule.revision,createdAt:now,replayed:false,...result};
      this.#db.prepare("INSERT INTO receipts(client_request_id,request_hash,receipt_json,created_at) VALUES(?,?,?,?)").run(input.clientRequestId,hash,JSON.stringify(receipt),now);
      return receipt;
    });
  }
  createAutomation(raw:unknown):AgendaMutationReceipt {
    const input=AutomationCreateSchema.parse(raw),when=validateAutomationWhen(input.when),now=parseTimestamp(this.#clock());
    return this.#mutation("create",input,null,()=>{
      if(when.kind!=="cron"&&(when.kind==="once"?when.at:when.firstAt)<=now)throw new HostError("invalid_input","New automation must begin in the future.");
      return {schedule:this.#create({...input,when},now)};
    });
  }
  #withdrawUnaccepted(schedule:AgendaSchedule,now:number):void {
    const rows=this.#db.prepare("SELECT * FROM occurrences WHERE schedule_id=? AND state='prepared'").all(schedule.id) as Row[];
    for(const row of rows){
      const turn=this.#store.findTurn(schedule.threadId,str(row,"client_request_id"));
      if(turn){
        if(turn.botId!==schedule.botId||this.#store.turnInput(turn.id)!==schedule.content)throw new HostError("conflict","Automation accepted turn cannot be reconciled.");
        this.#db.prepare("UPDATE occurrences SET state='accepted',turn_id=?,updated_at=? WHERE schedule_id=? AND scheduled_at=?").run(turn.id,now,schedule.id,num(row,"scheduled_at"));
      } else this.#db.prepare("UPDATE occurrences SET state='withdrawn',updated_at=? WHERE schedule_id=? AND scheduled_at=?").run(now,schedule.id,num(row,"scheduled_at"));
    }
  }
  updateAutomation(id:string,raw:unknown):AgendaMutationReceipt {
    const input=AutomationUpdateSchema.parse(raw),when=validateAutomationWhen(input.when);
    return this.#mutation("update",input,id,()=>{
      const old=scheduleFrom(this.#row(id)),now=parseTimestamp(this.#clock());
      if(old.state==="completed")throw new HostError("conflict","Completed automation cannot be edited; create a new one.");
      const nextAt=when.kind==="once"?when.at:when.kind==="interval"?when.firstAt:nextAutomationAt(when,now);
      if(nextAt!==null&&nextAt<=now)throw new HostError("invalid_input","Edited automation must begin in the future.");
      this.#withdrawUnaccepted(old,now);
      this.#db.prepare("UPDATE schedules SET title=?,content=?,kind=?,at=?,interval_ms=?,cron=?,time_zone=?,next_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(input.title,input.content,when.kind,when.kind==="once"?when.at:null,when.kind==="interval"?when.everyMs:null,when.kind==="cron"?when.expression:null,when.kind==="cron"?when.timeZone:null,nextAt,now,id,input.expectedRevision);
      return {schedule:scheduleFrom(this.#row(id))};
    });
  }
  stateAutomation(id:string,raw:unknown):AgendaMutationReceipt {
    const input=AutomationStateSchema.parse(raw);
    return this.#mutation("state",input,id,()=>{
      const old=scheduleFrom(this.#row(id)),now=parseTimestamp(this.#clock());
      if(old.state==="completed")throw new HostError("conflict","Completed automation cannot be resumed.");
      if(input.state==="disabled")this.#withdrawUnaccepted(old,now);
      this.#db.prepare("UPDATE schedules SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(input.state,now,id,input.expectedRevision);
      return {schedule:scheduleFrom(this.#row(id))};
    });
  }
  runAutomation(id:string,raw:unknown):AgendaMutationReceipt {
    const input=AutomationRunSchema.parse(raw);
    return this.#mutation("run",input,id,()=>{
      const schedule=scheduleFrom(this.#row(id)),now=parseTimestamp(this.#clock());
      if(schedule.state!=="active")throw new HostError("conflict","Resume the automation before running it.");
      if(this.#overlap(id))throw new HostError("conflict","An automation occurrence is active or unknown. The human owner must acknowledge unknown action/turn receipts through their reconciliation operation before another run.");
      if(this.#db.prepare("SELECT 1 FROM occurrences WHERE schedule_id=? AND scheduled_at=?").get(id,now)||schedule.nextAt===now)throw new HostError("conflict","An occurrence already owns this instant. Reload before retrying.");
      const request=`agenda_manual_${createHash("sha256").update(input.clientRequestId).digest("hex")}`;
      this.#db.prepare("INSERT INTO occurrences(schedule_id,scheduled_at,schedule_revision,client_request_id,state,attempts,created_at,updated_at,source) VALUES(?,?,?,?,'prepared',0,?,?,'manual')").run(id,now,schedule.revision,request,now,now);
      return {schedule,occurrence:occurrenceFrom(this.#db.prepare("SELECT * FROM occurrences WHERE schedule_id=? AND scheduled_at=?").get(id,now) as Row)};
    });
  }
  listAutomations(raw:unknown):AgendaPage<AgendaSchedule,AgendaScheduleCursor> {
    const input=AutomationListSchema.parse(raw);this.#host(input);
    return this.#fenced(()=>{
      if(input.botId&&this.#store.getBot(input.botId).ownerId!==this.#store.ownerId)throw new HostError("forbidden","Automation bot ownership is invalid.");
      const rows=this.#db.prepare("SELECT * FROM schedules WHERE (? IS NULL OR bot_id=?) AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?")
        .all(input.botId??null,input.botId??null,input.after?.id??null,input.after?.createdAt??0,input.after?.createdAt??0,input.after?.id??"",(input.limit??100)+1) as Row[];
      const selected=rows.slice(0,input.limit??100),last=selected.at(-1);
      return {items:selected.map(scheduleFrom),nextCursor:rows.length>(input.limit??100)&&last?{createdAt:num(last,"created_at"),id:str(last,"id")}:null};
    });
  }
  historyAutomations(raw:unknown):AgendaPage<AgendaHistoryItem,AgendaOccurrenceCursor> {
    const input=AutomationHistorySchema.parse(raw);this.#host(input);
    return this.#fenced(()=>{
      if(input.scheduleId)this.#row(input.scheduleId);
      if(input.botId&&this.#store.getBot(input.botId).ownerId!==this.#store.ownerId)throw new HostError("forbidden","Automation bot ownership is invalid.");
      if(input.after&&input.scheduleId&&input.after.scheduleId!==input.scheduleId)throw new HostError("invalid_input","Automation history cursor does not match filter.");
      const rows=this.#db.prepare("SELECT o.* FROM occurrences o JOIN schedules s ON s.id=o.schedule_id WHERE (? IS NULL OR o.schedule_id=?) AND (? IS NULL OR s.bot_id=?) AND (? IS NULL OR o.schedule_id>? OR(o.schedule_id=? AND o.scheduled_at>?)) ORDER BY o.schedule_id,o.scheduled_at LIMIT ?")
        .all(input.scheduleId??null,input.scheduleId??null,input.botId??null,input.botId??null,input.after?.scheduleId??null,input.after?.scheduleId??"",input.after?.scheduleId??"",input.after?.scheduledAt??0,(input.limit??100)+1) as Row[];
      const selected=rows.slice(0,input.limit??100),last=selected.at(-1);
      return {items:selected.map(row=>this.#history(row)),nextCursor:rows.length>(input.limit??100)&&last?{scheduleId:str(last,"schedule_id"),scheduledAt:num(last,"scheduled_at")}:null};
    });
  }
  previewAutomation(raw:unknown):{hostId:string;when:AgendaWhen;dates:number[]} {
    const input=AutomationPreviewSchema.parse(raw);this.#host(input);const when=validateAutomationWhen(input.when),dates:number[]=[];
    let after=input.after??parseTimestamp(this.#clock());
    for(let index=0;index<(input.count??5);index++){const next=nextAutomationAt(when,after);if(next===null)break;dates.push(next);after=next;}
    return {hostId:this.#store.hostId,when,dates};
  }
  calendarAutomations(raw:unknown):{from:number;to:number;items:AgendaCalendarItem[];truncated:boolean} {
    const input=AutomationCalendarSchema.parse(raw);this.#host(input);
    return this.#fenced(()=>{
      if(input.botId&&this.#store.getBot(input.botId).ownerId!==this.#store.ownerId)throw new HostError("forbidden","Automation bot ownership is invalid.");
      const limit=input.limit??1000,items:AgendaCalendarItem[]=[];
      const add=(item:AgendaCalendarItem)=>{items.push(item);items.sort((a,b)=>a.scheduledAt-b.scheduledAt||a.scheduleId.localeCompare(b.scheduleId));if(items.length>limit+1)items.pop();};
      const actual=this.#db.prepare("SELECT o.* FROM occurrences o JOIN schedules s ON s.id=o.schedule_id WHERE o.scheduled_at>=? AND o.scheduled_at<? AND(? IS NULL OR s.bot_id=?) ORDER BY o.scheduled_at,o.schedule_id LIMIT ?")
        .all(input.from,input.to,input.botId??null,input.botId??null,limit+1) as Row[];
      for(const row of actual){const item=this.#history(row);add({...item,occurrenceState:item.state});}
      const schedules=this.#db.prepare("SELECT * FROM schedules WHERE state='active' AND next_at IS NOT NULL AND (? IS NULL OR bot_id=?) ORDER BY next_at,id").all(input.botId??null,input.botId??null) as Row[];
      const candidates:Array<{schedule:AgendaSchedule;when:AgendaWhen;next:number}>=[];
      for(const row of schedules){
        const schedule=scheduleFrom(row),when=scheduleWhen(schedule);let next=schedule.nextAt!;
        if(next<input.from)next=nextAutomationAt(when,Math.max(0,input.from-1))??input.to;
        if(next<input.to)candidates.push({schedule,when,next});
      }
      candidates.sort((a,b)=>a.next-b.next||a.schedule.id.localeCompare(b.schedule.id));
      // At most limit+1 recurrence expansions, irrespective of the number or density of schedules.
      for(let emitted=0;emitted<=limit&&candidates.length;emitted++){
        const candidate=candidates.shift()!,{schedule,when,next}=candidate;
        if(!this.#db.prepare("SELECT 1 FROM occurrences WHERE schedule_id=? AND scheduled_at=?").get(schedule.id,next))add({scheduleId:schedule.id,botId:schedule.botId,threadId:schedule.threadId,title:schedule.title,scheduledAt:next,source:"projected"});
        const following=nextAutomationAt(when,next);
        if(following!==null&&following>next&&following<input.to){
          candidate.next=following;let lo=0,hi=candidates.length;
          while(lo<hi){const mid=Math.floor((lo+hi)/2),other=candidates[mid]!;if(other.next<following||(other.next===following&&other.schedule.id.localeCompare(schedule.id)<0))lo=mid+1;else hi=mid;}
          candidates.splice(lo,0,candidate);
        }
      }
      return {from:input.from,to:input.to,items:items.slice(0,limit),truncated:items.length>limit||candidates.length>0};
    });
  }

  listSchedules(options: AgendaScheduleListOptions = {}): AgendaPage<AgendaSchedule, AgendaScheduleCursor> {
    const page = scheduleListArgs(options);
    return this.#fenced(() => {
      const rows = (page.after
        ? this.#db.prepare(`SELECT * FROM schedules WHERE created_at > ? OR (created_at = ? AND id > ?)
            ORDER BY created_at, id LIMIT ?`).all(page.after.createdAt, page.after.createdAt, page.after.id, page.limit + 1)
        : this.#db.prepare("SELECT * FROM schedules ORDER BY created_at, id LIMIT ?").all(page.limit + 1)) as Row[];
      const selected = rows.slice(0, page.limit);
      const last = selected.at(-1);
      return {
        items: selected.map(scheduleFrom),
        nextCursor: rows.length > page.limit && last
          ? { createdAt: num(last, "created_at"), id: str(last, "id") }
          : null,
      };
    });
  }

  listOccurrences(options: AgendaOccurrenceListOptions = {}): AgendaPage<AgendaOccurrence, AgendaOccurrenceCursor> {
    const page = occurrenceListArgs(options);
    return this.#fenced(() => {
      let rows: Row[];
      if (page.scheduleId !== undefined && page.after) {
        rows = this.#db.prepare(`SELECT * FROM occurrences WHERE schedule_id = ? AND scheduled_at > ?
          ORDER BY schedule_id, scheduled_at LIMIT ?`).all(page.scheduleId, page.after.scheduledAt, page.limit + 1) as Row[];
      } else if (page.scheduleId !== undefined) {
        rows = this.#db.prepare(`SELECT * FROM occurrences WHERE schedule_id = ?
          ORDER BY schedule_id, scheduled_at LIMIT ?`).all(page.scheduleId, page.limit + 1) as Row[];
      } else if (page.after) {
        rows = this.#db.prepare(`SELECT * FROM occurrences
          WHERE schedule_id > ? OR (schedule_id = ? AND scheduled_at > ?)
          ORDER BY schedule_id, scheduled_at LIMIT ?`).all(page.after.scheduleId, page.after.scheduleId,
          page.after.scheduledAt, page.limit + 1) as Row[];
      } else {
        rows = this.#db.prepare("SELECT * FROM occurrences ORDER BY schedule_id, scheduled_at LIMIT ?").all(page.limit + 1) as Row[];
      }
      const selected = rows.slice(0, page.limit);
      const last = selected.at(-1);
      return {
        items: selected.map(occurrenceFrom),
        nextCursor: rows.length > page.limit && last
          ? { scheduleId: str(last, "schedule_id"), scheduledAt: num(last, "scheduled_at") }
          : null,
      };
    });
  }

  /** Owner-only, explicit maintenance. Prepared or ambiguous intents are never eligible for pruning. */
  pruneTerminalOccurrences(options: AgendaRetentionOptions): AgendaRetentionReport {
    const retention = retentionArgs(options);
    return this.#fenced(() => {
      const rows = this.#db.prepare(`SELECT schedule_id, scheduled_at FROM occurrences
        WHERE state IN ('accepted', 'withdrawn', 'blocked') AND updated_at <= ?
        ORDER BY updated_at, schedule_id, scheduled_at LIMIT ?`)
        .all(retention.beforeUpdatedAt, retention.limit + 1) as Row[];
      const truncated = rows.length > retention.limit;
      let deleted = 0;
      for (const row of rows.slice(0, retention.limit)) {
        const current=this.#db.prepare("SELECT turn_id FROM occurrences WHERE schedule_id=? AND scheduled_at=?").get(str(row,"schedule_id"),num(row,"scheduled_at")) as Row|undefined;
        if(current&&current.turn_id!==null&&["queued","running","unknown"].includes(this.#store.getTurn(str(current,"turn_id")).state))continue;
        this.#db.prepare(`DELETE FROM occurrences WHERE schedule_id = ? AND scheduled_at = ?
          AND state IN ('accepted', 'withdrawn', 'blocked') AND updated_at <= ?`)
          .run(str(row, "schedule_id"), num(row, "scheduled_at"), retention.beforeUpdatedAt);
        deleted += num(this.#db.prepare("SELECT changes() AS n").get() as Row, "n");
      }
      return { deleted, truncated };
    });
  }

  /** Owner-only explicit capacity cleanup. Terminal occurrences must be pruned first; Hub turns are untouched. */
  deleteTerminalSchedule(scheduleId: string): void {
    if (!IdSchema.safeParse(scheduleId).success) throw new HostError("invalid_input", "agenda schedule id is invalid");
    this.#fenced(() => {
      const row = this.#db.prepare("SELECT state FROM schedules WHERE id = ?").get(scheduleId) as Row | undefined;
      if (!row) throw new HostError("not_found", "agenda schedule not found");
      if (str(row, "state") === "active") throw new HostError("conflict", "only a disabled or completed schedule can be deleted");
      if(this.#db.prepare("SELECT 1 FROM receipts WHERE json_extract(receipt_json,'$.scheduleId')=? LIMIT 1").get(scheduleId))throw new HostError("conflict","Automation has durable mutation receipts and cannot be deleted.");
      const occurrence = this.#db.prepare("SELECT 1 AS present FROM occurrences WHERE schedule_id = ? LIMIT 1").get(scheduleId);
      if (occurrence) throw new HostError("conflict", "prune terminal occurrences before deleting the schedule");
      this.#db.prepare("DELETE FROM schedules WHERE id = ? AND state IN ('disabled', 'completed')").run(scheduleId);
      if (num(this.#db.prepare("SELECT changes() AS n").get() as Row, "n") !== 1) {
        throw new HostError("conflict", "agenda schedule changed concurrently");
      }
    });
  }

  disable(scheduleId: string): AgendaSchedule {
    if (!IdSchema.safeParse(scheduleId).success) throw new HostError("invalid_input", "agenda schedule id is invalid");
    const now = parseTimestamp(this.#clock());
    return this.#fenced(() => {
      const row = this.#db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as Row | undefined;
      if (!row) throw new HostError("not_found", "agenda schedule not found");
      const schedule = scheduleFrom(row);
      if (schedule.state !== "active") return schedule;
      const revision = schedule.revision + 1;
      this.#db.prepare("UPDATE schedules SET state = 'disabled', revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(revision, now, scheduleId, schedule.revision);
      if (num(this.#db.prepare("SELECT changes() AS n").get() as Row, "n") !== 1) {
        throw new HostError("conflict", "agenda schedule changed concurrently");
      }
      const pending = this.#db.prepare(`SELECT * FROM occurrences
        WHERE schedule_id = ? AND state = 'prepared' AND schedule_revision < ?`).all(scheduleId, revision) as Row[];
      for (const occurrence of pending) {
        const existing = this.#store.findTurn(schedule.threadId, str(occurrence, "client_request_id"));
        if (!existing) {
          this.#db.prepare(`UPDATE occurrences SET state = 'withdrawn', updated_at = ?
            WHERE schedule_id = ? AND scheduled_at = ? AND state = 'prepared'`)
            .run(now, scheduleId, num(occurrence, "scheduled_at"));
        } else if (existing.threadId === schedule.threadId && this.#store.turnInput(existing.id) === schedule.content) {
          this.#db.prepare(`UPDATE occurrences SET state = 'accepted', turn_id = ?, updated_at = ?
            WHERE schedule_id = ? AND scheduled_at = ? AND state = 'prepared' AND client_request_id = ?`)
            .run(existing.id, now, scheduleId, num(occurrence, "scheduled_at"), existing.clientRequestId);
        } else {
          this.#db.prepare(`UPDATE occurrences SET state = 'blocked', updated_at = ?
            WHERE schedule_id = ? AND scheduled_at = ? AND state = 'prepared'`)
            .run(now, scheduleId, num(occurrence, "scheduled_at"));
        }
      }
      return scheduleFrom(this.#db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as Row);
    });
  }

  /** Re-enables an interval at a fresh future UTC anchor. Old prepared intents stay withdrawn across ABA changes. */
  enableInterval(scheduleId: string, firstAt: number): AgendaSchedule {
    if (!IdSchema.safeParse(scheduleId).success) throw new HostError("invalid_input", "agenda schedule id is invalid");
    const nextAt = parseTimestamp(firstAt);
    const now = parseTimestamp(this.#clock());
    if (nextAt <= now) throw new HostError("invalid_input", "re-enabled interval must start in the future");
    return this.#fenced(() => {
      const row = this.#db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as Row | undefined;
      if (!row) throw new HostError("not_found", "agenda schedule not found");
      const schedule = scheduleFrom(row);
      if (schedule.kind !== "interval" || schedule.state !== "disabled" || schedule.intervalMs === null) {
        throw new HostError("conflict", "only a disabled interval can be re-enabled");
      }
      const lastOccurrenceAt = maybeNum(row, "last_occurrence_at");
      if (lastOccurrenceAt !== null && nextAt <= lastOccurrenceAt) throw new HostError("conflict", "new interval anchor must follow prior occurrences");
      this.#db.prepare(`UPDATE schedules SET state = 'active', next_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`)
        .run(nextAt, now, scheduleId, schedule.revision);
      if (num(this.#db.prepare("SELECT changes() AS n").get() as Row, "n") !== 1) {
        throw new HostError("conflict", "agenda schedule changed concurrently");
      }
      return scheduleFrom(this.#db.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as Row);
    });
  }

  /**
   * Captures at most one due occurrence per schedule. Missed interval anchors coalesce to the latest due slot;
   * no backlog loop or immediate catch-up storm is generated. This commits before any call to the runtime.
   */
  prepareDue(): AgendaPreparation {
    const now = parseTimestamp(this.#clock());
    return this.#fenced(() => {
      const due = this.#db.prepare(`SELECT s.* FROM schedules s
        WHERE s.state = 'active' AND s.next_at IS NOT NULL AND s.next_at <= ?
          AND NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.schedule_id = s.id AND o.state = 'prepared')
        ORDER BY s.next_at, s.id LIMIT ?`).all(now, this.#maxSchedules + 1) as Row[];
      const truncated = due.length > this.#maxSchedules;
      let prepared = 0;
      for (const row of due.slice(0, this.#maxSchedules)) {
        const schedule = scheduleFrom(row);
        const nextAt = schedule.nextAt;
        if (nextAt === null || this.#overlap(schedule.id)) continue;
        const scheduledAt = schedule.kind === "interval" && schedule.intervalMs !== null
          ? nextAt + Math.floor((now - nextAt) / schedule.intervalMs) * schedule.intervalMs
          : schedule.kind==="cron"?latestCronAt(scheduleWhen(schedule),now,nextAt):nextAt;
        const followingAt = schedule.kind === "interval" && schedule.intervalMs !== null
          ? scheduledAt + schedule.intervalMs : schedule.kind==="cron"?nextAutomationAt(scheduleWhen(schedule),now):null;
        if (!Number.isSafeInteger(scheduledAt) || (followingAt !== null && !Number.isSafeInteger(followingAt))) {
          this.#db.prepare("UPDATE schedules SET state = 'completed', next_at = NULL, updated_at = ? WHERE id = ? AND revision = ?")
            .run(now, schedule.id, schedule.revision);
          continue;
        }
        this.#db.prepare(`INSERT INTO occurrences
          (schedule_id, scheduled_at, schedule_revision, client_request_id, state, attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'prepared', 0, ?, ?)
          ON CONFLICT (schedule_id, scheduled_at) DO NOTHING`)
          .run(schedule.id, scheduledAt, schedule.revision, requestId(schedule.id, scheduledAt), now, now);
        const inserted = this.#db.prepare("SELECT changes() AS n").get() as Row;
        if (num(inserted, "n") > 0) prepared += 1;
        this.#db.prepare(`UPDATE schedules SET next_at = ?, last_occurrence_at =
          CASE WHEN last_occurrence_at IS NULL OR last_occurrence_at < ? THEN ? ELSE last_occurrence_at END,
          updated_at = ? WHERE id = ? AND revision = ? AND state = 'active'`)
          .run(followingAt, scheduledAt, scheduledAt, now, schedule.id, schedule.revision);
      }
      const pending = num(this.#db.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE state = 'prepared'").get() as Row, "n");
      return { prepared, pending, truncated };
    });
  }

  /** Dispatches prepared intents through the existing Hub Runtime, using the same id on every recovery attempt. */
  dispatchPrepared(runtime: AgendaRuntime): AgendaDispatchReport {
    const pendingRows = this.#fenced(() => this.#db.prepare(`SELECT o.*, s.owner_id, s.installation_id, s.bot_id, s.thread_id,
        s.content, s.state AS schedule_state, s.revision AS current_revision
      FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
      WHERE o.state = 'prepared' ORDER BY o.attempts, o.updated_at, o.schedule_id, o.scheduled_at LIMIT ?`)
      .all(this.#maxDispatches + 1) as Row[]);
    const truncated = pendingRows.length > this.#maxDispatches;
    const attempts: AgendaAttempt[] = [];
    let attempted = 0, accepted = 0, replayed = 0, deferred = 0, withdrawn = 0, blocked = 0;
    for (const pending of pendingRows.slice(0, this.#maxDispatches)) {
      const scheduleId = str(pending, "schedule_id");
      const scheduledAt = num(pending, "scheduled_at");
      const claim = this.#fenced(() => {
        const row = this.#db.prepare(`SELECT o.*, s.owner_id, s.installation_id, s.bot_id, s.thread_id,
            s.content, s.state AS schedule_state, s.revision AS current_revision
          FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
          WHERE o.schedule_id = ? AND o.scheduled_at = ?`).get(scheduleId, scheduledAt) as Row | undefined;
        if (!row || str(row, "state") !== "prepared") return { kind: "handled" as const };
        if (str(row, "schedule_state") !== "active" || num(row, "schedule_revision") !== num(row, "current_revision")) {
          this.#db.prepare("UPDATE occurrences SET state = 'withdrawn', updated_at = ? WHERE schedule_id = ? AND scheduled_at = ? AND state = 'prepared'")
            .run(parseTimestamp(this.#clock()), scheduleId, scheduledAt);
          return { kind: "withdrawn" as const };
        }
        if (str(row, "owner_id") !== this.#store.ownerId || str(row, "installation_id") !== this.#store.hostId) {
          this.#db.prepare("UPDATE occurrences SET state = 'blocked', updated_at = ? WHERE schedule_id = ? AND scheduled_at = ? AND state = 'prepared'")
            .run(parseTimestamp(this.#clock()), scheduleId, scheduledAt);
          return { kind: "blocked" as const };
        }
        try {
          const thread = this.#store.getThread(str(row, "thread_id"));
          const bot = this.#store.getBot(str(row, "bot_id"));
          if (thread.botId !== bot.id || bot.ownerId !== this.#store.ownerId) throw new Error("binding");
        } catch {
          this.#db.prepare("UPDATE occurrences SET state = 'blocked', updated_at = ? WHERE schedule_id = ? AND scheduled_at = ? AND state = 'prepared'")
            .run(parseTimestamp(this.#clock()), scheduleId, scheduledAt);
          return { kind: "blocked" as const };
        }
        if(this.#overlap(scheduleId,true))return {kind:"deferred" as const};
        this.#db.prepare("UPDATE occurrences SET attempts = attempts + 1, updated_at = ? WHERE schedule_id = ? AND scheduled_at = ? AND state = 'prepared'")
          .run(parseTimestamp(this.#clock()), scheduleId, scheduledAt);
        return {
          kind: "start" as const, threadId: str(row, "thread_id"), content: str(row, "content"),
          clientRequestId: str(row, "client_request_id"),
        };
      });
      if (claim.kind === "handled") {
        attempts.push({ scheduleId, scheduledAt, state: "already_handled", turnId: null });
        continue;
      }
      if (claim.kind === "withdrawn") {
        withdrawn += 1; attempts.push({ scheduleId, scheduledAt, state: "withdrawn", turnId: null }); continue;
      }
      if (claim.kind === "blocked") {
        blocked += 1; attempts.push({ scheduleId, scheduledAt, state: "blocked", turnId: null }); continue;
      }

      if(claim.kind==="deferred"){deferred++;attempts.push({scheduleId,scheduledAt,state:"deferred",turnId:null});continue;}
      let started: StartedTurn;
      attempted += 1;
      try {
        const parsedInput = StartTurnSchema.safeParse({ clientRequestId: claim.clientRequestId, content: claim.content });
        if (!parsedInput.success) throw new HostError("invalid_input", "agenda content is no longer valid");
        started = runtime.startTurn(claim.threadId, parsedInput.data);
        if (started.turn.threadId !== claim.threadId || started.turn.clientRequestId !== claim.clientRequestId) throw new Error("receipt mismatch");
      } catch {
        // The HostStore transaction may have committed before a response was lost. Keep the exact same ID
        // and content durably pending; Runtime.startTurn will return its existing turn if it was accepted.
        deferred += 1; attempts.push({ scheduleId, scheduledAt, state: "deferred", turnId: null }); continue;
      }

      try {
        this.#fenced(() => {
          this.#db.prepare(`UPDATE occurrences SET state = 'accepted', turn_id = ?, updated_at = ?
            WHERE schedule_id = ? AND scheduled_at = ? AND state IN ('prepared', 'withdrawn')
              AND turn_id IS NULL AND client_request_id = ?`)
            .run(started.turn.id, parseTimestamp(this.#clock()), scheduleId, scheduledAt, claim.clientRequestId);
          const result = this.#db.prepare("SELECT changes() AS n").get() as Row;
          if (num(result, "n") === 0) {
            const current = this.#db.prepare("SELECT state, turn_id FROM occurrences WHERE schedule_id = ? AND scheduled_at = ?").get(scheduleId, scheduledAt) as Row | undefined;
            if (!current || str(current, "state") !== "accepted" || str(current, "turn_id") !== started.turn.id) {
              throw new HostError("conflict", "agenda receipt could not be confirmed");
            }
          }
          this.#db.prepare(`UPDATE schedules SET state = 'completed', updated_at = ?
            WHERE id = ? AND kind = 'once' AND state = 'active' AND EXISTS(SELECT 1 FROM occurrences WHERE schedule_id=? AND scheduled_at=? AND source='scheduled') AND revision =
              (SELECT schedule_revision FROM occurrences WHERE schedule_id = ? AND scheduled_at = ?)`)
            .run(parseTimestamp(this.#clock()), scheduleId, scheduleId,scheduledAt,scheduleId, scheduledAt);
        });
        if (started.created) accepted += 1; else replayed += 1;
        attempts.push({ scheduleId, scheduledAt, state: started.created ? "accepted" : "replayed", turnId: started.turn.id });
      } catch {
        // Runtime already accepted this ID, but the local receipt did not confirm. Retry only this ID next tick.
        deferred += 1; attempts.push({ scheduleId, scheduledAt, state: "deferred", turnId: null });
      }
    }
    const pending = this.#fenced(() => num(this.#db.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE state = 'prepared'").get() as Row, "n"));
    return { attempted, accepted, replayed, deferred, withdrawn, blocked, pending, truncated, attempts };
  }

  /** One explicit bounded scheduler pass. No timer, calendar recurrence or engine work is created here. */
  tick(runtime: AgendaRuntime): AgendaTickReport {
    const prepared = this.prepareDue();
    const dispatched = this.dispatchPrepared(runtime);
    return { ...prepared, ...dispatched, truncated: prepared.truncated || dispatched.truncated };
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#store.withWriterLease(() => { this.#db.close(); this.#closed = true; });
    } catch (error) {
      // Closing an idle SQLite handle has no schedule effect. Permit orderly cleanup after a caller already
      // closed its HostStore; all agenda operations remain fenced and fail closed.
      this.#db.close(); this.#closed = true;
      if (!(error instanceof HostError) || error.code !== "host_locked") throw error;
    }
  }
}

export { AgendaHostConsumer, type AgendaHostConsumerOptions, type AgendaHostAdmin, type AgendaConsumerStatus } from "./host-consumer.js";
