import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { BOT_MEMORY_MAX_CHARACTERS } from "@dexter/contracts";
import { OperationsError, fail } from "./errors.js";
import { entry, readBounded } from "./files.js";

/**
 * Context Git is read as data, never through the `git` binary: no hooks, config, fsmonitor, alternates or
 * attributes of the source repository are executed or honoured. Only the shape ContextRepository produces is
 * accepted: SHA-1 loose objects, `HEAD -> refs/heads/master`, no packs, no other refs. Anything else fails closed.
 */
export const GIT_PREFIX = "context-git/";
export const GIT_HEAD = "ref: refs/heads/master\n";
const OBJECT_ID = /^[0-9a-f]{40}$/;
const OBJECT_DIR = /^[0-9a-f]{2}$/;
const OBJECT_FILE = /^[0-9a-f]{38}$/;
const TEMP_OBJECT = /^tmp_obj_[A-Za-z0-9]{1,32}$/;
export const GIT_MEMBER = /^context-git\/(?:HEAD|refs\/heads\/master|objects\/[0-9a-f]{2}\/[0-9a-f]{38})$/;

export interface GitLimits {
  maxObjects: number;
  maxObjectBytes: number;
  maxInflatedObjectBytes: number;
  /** Aggregate inflated bytes (headers included) over every object; each inflate is capped by what remains. */
  maxInflatedBytes: number;
  /** Aggregate commit/tree bytes scanned while walking history and resolving paths. */
  maxTraversalBytes: number;
}

const HEADER_ALLOWANCE = 64;
// A valid UTF-8 encoding needs at most three bytes per UTF-16 code unit (four-byte scalars use two units).
const MAX_DOCUMENT_UTF8_BYTES = 3 * BOT_MEMORY_MAX_CHARACTERS;
const DOCUMENT_PATH = /^memory\/[A-Za-z0-9_-]{1,128}\/(?:SOUL|USER|MEMORY)-r[1-9][0-9]{0,15}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.md$/;

/**
 * One aggregate inflation budget per capture or restore. Each `inflateSync` gets `maxOutputLength` equal to the
 * smaller of the per-object bound and what remains, so zlib stops (and nothing larger is allocated) before the
 * aggregate is exceeded; the bytes actually produced are then charged.
 */
export class InflationBudget {
  #remaining: number;
  readonly #perObject: number;
  constructor(limits: GitLimits) { this.#remaining = limits.maxInflatedBytes; this.#perObject = limits.maxInflatedObjectBytes + HEADER_ALLOWANCE; }
  inflate(id: string, compressed: Buffer): GitObject {
    const aggregate = this.#remaining < this.#perObject;
    const cap = Math.min(this.#perObject, this.#remaining);
    if (cap < 1) fail("quota_exceeded", "context Git exceeds the aggregate inflation limit");
    const object = inflateObject(id, compressed, cap, aggregate);
    this.#remaining -= object.inflated;
    return object;
  }
}

function directory(path: string): void {
  const stat = entry(path);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe_path", "context git layout is not trusted");
}
function list(path: string): string[] {
  directory(path);
  try { return readdirSync(path).sort(); }
  catch (error) { throw new OperationsError("unsafe_path", "context git directory could not be read", { cause: error }); }
}
function regular(path: string, maxBytes: number, admit?: (bytes: number) => void): Buffer {
  const stat = entry(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) fail("unsafe_path", "context git file is not trusted");
  return readBounded(path, maxBytes, admit);
}
function absent(path: string, message: string): void {
  if (entry(path) !== undefined) fail("unsupported_schema", message);
}

/**
 * Synchronous, bounded copy of the allowlisted Git members of `<dataDir>/context-revisions`. `admit(member, bytes)`
 * is charged before each file is allocated; every object is verified under one aggregate inflation budget and its
 * inflated bytes are discarded immediately.
 */
export function readContextGit(root: string, limits: GitLimits, admit: (member: string, bytes: number) => void): Map<string, Buffer> {
  directory(root);
  const git = join(root, ".git");
  directory(git);
  absent(join(git, "commondir"), "linked Git worktrees are not supported");
  absent(join(git, "packed-refs"), "packed Git refs are not supported");
  absent(join(git, "shallow"), "shallow Git repositories are not supported");
  absent(join(git, "objects", "info", "alternates"), "Git alternates are not supported");
  const config = regular(join(git, "config"), 4096).toString("utf8");
  if (/objectformat|worktree\s*=|\[extensions\]/i.test(config)) fail("unsupported_schema", "Git repository extensions are not supported");
  const members = new Map<string, Buffer>();
  const head = regular(join(git, "HEAD"), 256, (bytes) => admit(`${GIT_PREFIX}HEAD`, bytes));
  if (head.toString("latin1") !== GIT_HEAD) fail("unsupported_schema", "context Git HEAD must point at refs/heads/master");
  members.set(`${GIT_PREFIX}HEAD`, head);

  // refs/: only refs/heads/master may exist; empty refs/tags and refs/heads are what `git init` creates.
  for (const name of list(join(git, "refs"))) {
    if (name === "tags") { if (list(join(git, "refs", "tags")).length) fail("unsupported_schema", "context Git tags are not supported"); continue; }
    if (name !== "heads") fail("unsupported_schema", "unexpected context Git ref namespace");
    for (const ref of list(join(git, "refs", "heads"))) {
      if (ref !== "master") fail("unsupported_schema", "unexpected context Git branch");
      const value = regular(join(git, "refs", "heads", "master"), 64, (bytes) => admit(`${GIT_PREFIX}refs/heads/master`, bytes));
      if (!/^[0-9a-f]{40}\n$/.test(value.toString("latin1"))) fail("corrupt", "context Git master ref is invalid");
      members.set(`${GIT_PREFIX}refs/heads/master`, value);
    }
  }

  const objects = join(git, "objects");
  let count = 0;
  const budget = new InflationBudget(limits);
  for (const name of list(objects)) {
    const path = join(objects, name);
    if (name === "info" || name === "pack") {
      if (list(path).length) fail("unsupported_schema", "packed Git objects are not supported");
      continue;
    }
    if (!OBJECT_DIR.test(name)) fail("unsupported_schema", "unexpected entry in context Git objects");
    for (const file of list(path)) {
      // An interrupted git write can leave a temporary object; it is not an object and is not copied.
      if (TEMP_OBJECT.test(file)) { const stat = entry(join(path, file)); if (!stat?.isFile() || stat.isSymbolicLink()) fail("unsafe_path", "context Git temporary file is not trusted"); continue; }
      if (!OBJECT_FILE.test(file)) fail("unsupported_schema", "unexpected file in context Git objects");
      if (++count > limits.maxObjects) fail("quota_exceeded", "context Git has too many objects");
      const member = `${GIT_PREFIX}objects/${name}/${file}`;
      const compressed = regular(join(path, file), limits.maxObjectBytes, (bytes) => admit(member, bytes));
      budget.inflate(`${name}${file}`, compressed);
      members.set(member, compressed);
    }
  }
  return members;
}

interface GitObject { type: "commit" | "tree" | "blob" | "tag"; body: Buffer; inflated: number }

/** Inflates with an explicit output bound (header included) and proves the object's SHA-1 equals its name. */
export function inflateObject(id: string, compressed: Buffer, maxRawBytes: number, aggregate = false): GitObject {
  let raw: Buffer;
  try { raw = inflateSync(compressed, { maxOutputLength: maxRawBytes }); }
  catch (error) {
    if (error instanceof RangeError) {
      throw new OperationsError("quota_exceeded", aggregate ? "context Git exceeds the aggregate inflation limit" : "context Git object exceeds the size limit", { cause: error });
    }
    throw new OperationsError("corrupt", "context Git object is not valid", { cause: error });
  }
  const nul = raw.indexOf(0);
  const header = nul > 0 && nul < 32 ? /^(commit|tree|blob|tag) (0|[1-9][0-9]{0,9})$/.exec(raw.subarray(0, nul).toString("latin1")) : null;
  if (!header || Number(header[2]) !== raw.length - nul - 1) fail("corrupt", "context Git object header is not valid");
  if (createHash("sha1").update(raw).digest("hex") !== id) fail("corrupt", "context Git object hash does not match its name");
  return { type: header![1] as GitObject["type"], body: raw.subarray(nul + 1), inflated: raw.length };
}

/**
 * Read-only view over validated, in-memory Git members (already authenticated by the envelope). Every object,
 * reachable or orphan, is inflated exactly once under one aggregate budget and checked against its name. Only
 * commit/tree bodies and document-sized blobs are retained under that same aggregate inflation budget. Other
 * blobs keep just their SHA-256. History/path lookups and bounded document decoding share the traversal budget.
 */
export class GitSnapshot {
  readonly #types = new Map<string, GitObject["type"]>();
  readonly #structure = new Map<string, Buffer>();
  readonly #blobDigests = new Map<string, string>();
  readonly #documentBlobs = new Map<string, Buffer>();
  #traversal: number;
  readonly master: string | null;
  #reachable: Set<string> | null = null;

  constructor(members: ReadonlyMap<string, Buffer>, limits: GitLimits) {
    this.#traversal = limits.maxTraversalBytes;
    const head = members.get(`${GIT_PREFIX}HEAD`);
    if (!head || head.toString("latin1") !== GIT_HEAD) fail("corrupt", "context Git HEAD is missing or invalid");
    const master = members.get(`${GIT_PREFIX}refs/heads/master`);
    if (master !== undefined && !/^[0-9a-f]{40}\n$/.test(master.toString("latin1"))) fail("corrupt", "context Git master ref is invalid");
    this.master = master === undefined ? null : master.toString("latin1").trim();
    const budget = new InflationBudget(limits);
    let objects = 0;
    for (const [name, bytes] of members) {
      const match = /^context-git\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/.exec(name);
      if (!match) continue;
      if (++objects > limits.maxObjects) fail("quota_exceeded", "context Git has too many objects");
      const id = `${match[1]}${match[2]}`;
      const object = budget.inflate(id, bytes);
      this.#types.set(id, object.type);
      if (object.type === "commit" || object.type === "tree") this.#structure.set(id, object.body);
      else if (object.type === "blob") {
        this.#blobDigests.set(id, createHash("sha256").update(object.body).digest("hex"));
        // The inflation budget was charged before decompression. Keep an internal view, never caller-owned bytes.
        if (object.body.length <= MAX_DOCUMENT_UTF8_BYTES) this.#documentBlobs.set(id, object.body);
      }
    }
    if (this.master !== null && this.#type(this.master) !== "commit") fail("reference_broken", "context Git master is not a commit");
  }

  #type(id: string): GitObject["type"] {
    if (!OBJECT_ID.test(id)) fail("reference_broken", "context Git object id is invalid");
    const type = this.#types.get(id);
    if (!type) return fail("reference_broken", "context Git object is missing");
    return type;
  }

  #body(id: string, type: "commit" | "tree"): Buffer {
    if (this.#type(id) !== type) fail(type === "commit" ? "reference_broken" : "corrupt", `context Git reference is not a ${type}`);
    const body = this.#structure.get(id)!;
    if (body.length > this.#traversal) fail("quota_exceeded", "context Git traversal exceeds its limit");
    this.#traversal -= body.length;
    return body;
  }

  #commit(id: string): { tree: string; parents: string[] } {
    const body = this.#body(id, "commit");
    const headerEnd = body.indexOf("\n\n");
    const lines = body.subarray(0, headerEnd < 0 ? body.length : headerEnd).toString("utf8").split("\n");
    const tree = /^tree ([0-9a-f]{40})$/.exec(lines[0] ?? "");
    if (!tree) return fail("corrupt", "context Git commit has no tree");
    const parents: string[] = [];
    for (const line of lines.slice(1)) {
      const parent = /^parent ([0-9a-f]{40})$/.exec(line);
      if (parent) parents.push(parent[1]!); else break;
    }
    return { tree: tree[1]!, parents };
  }

  #treeEntry(treeId: string, name: string): { mode: string; id: string } | null {
    const body = this.#body(treeId, "tree");
    let offset = 0;
    while (offset < body.length) {
      const space = body.indexOf(0x20, offset);
      const nul = body.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > body.length) fail("corrupt", "context Git tree is not valid");
      const mode = body.subarray(offset, space).toString("latin1");
      const entryName = body.subarray(space + 1, nul).toString("utf8");
      const id = body.subarray(nul + 1, nul + 21).toString("hex");
      offset = nul + 21;
      if (entryName === name) return { mode, id };
    }
    return null;
  }

  #reachableCommits(): Set<string> {
    if (this.#reachable) return this.#reachable;
    const seen = new Set<string>();
    const pending = this.master === null ? [] : [this.master];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      if (seen.size >= this.#types.size) fail("corrupt", "context Git history is not bounded");
      seen.add(id);
      pending.push(...this.#commit(id).parents);
    }
    this.#reachable = seen;
    return seen;
  }

  /** Every commit reachable from master. A defensive copy cannot change the private eligibility cache. */
  reachable(): Set<string> { return new Set(this.#reachableCommits()); }

  #blobAt(commit: string, path: string): string {
    if (!this.#reachableCommits().has(commit)) fail("reference_broken", "context Git commit is not in the snapshot history");
    let current = this.#commit(commit).tree;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      const found = this.#treeEntry(current, part);
      const last = index === parts.length - 1;
      if (!found || (!last && found.mode !== "40000") || (last && found.mode !== "100644" && found.mode !== "100755")) {
        fail("reference_broken", "context Git path is missing from its commit");
      }
      current = found!.id;
    }
    if (this.#type(current) !== "blob") fail("reference_broken", "context Git path is not a file");
    return current;
  }

  /** SHA-256 of the blob at `path` in `commit`; the commit must be part of master's history. */
  blobSha256(commit: string, path: string): string {
    return this.#blobDigests.get(this.#blobAt(commit, path))!;
  }

  /** Exact bounded bot-document text, only from a reachable commit/path/hash in this authenticated snapshot. */
  documentText(commit: string, path: string, expectedSha256: string): string {
    if (!DOCUMENT_PATH.test(path) || !/^[0-9a-f]{64}$/.test(expectedSha256)) fail("reference_broken", "context document pin is not valid");
    const id = this.#blobAt(commit, path);
    if (this.#blobDigests.get(id) !== expectedSha256) fail("reference_broken", "context document pin hash does not match its Git blob");
    const bytes = this.#documentBlobs.get(id);
    if (!bytes) fail("quota_exceeded", "context document blob exceeds its schema byte bound");
    if (bytes.length > this.#traversal) fail("quota_exceeded", "context document reading exceeds the traversal limit");
    this.#traversal -= bytes.length; // Charge before decoding/allocation; repeated reads never receive a fresh budget.
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return fail("corrupt", "context document blob is not valid UTF-8"); }
    // ignoreBOM preserves an authored BOM. Fatal UTF-8 decoding neither replaces bytes nor normalizes Unicode.
    if (text.length > BOT_MEMORY_MAX_CHARACTERS) fail("quota_exceeded", "context document exceeds its schema character bound");
    return text;
  }
}
