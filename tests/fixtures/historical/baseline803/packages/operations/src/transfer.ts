import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACTIVATION_MARKER_FILE, HostStore, activationReservationPath, type HostAuthorityActivationReport, type HostAuthorityStatus } from "@dexter/hub";
import {
  CHECKPOINT_COMPONENTS, CHECKPOINT_MEMBERS, CHECKPOINT_SOURCE_FILES, CONTEXT_REPOSITORY, RELAY_HOST_DIRECTORY, captureCheckpointArtifact, checkCheckpointAuthority, contextWorkingTree, gitSnapshotOf,
  openCheckpointArtifact, validateCheckpointStores, type CheckpointCaptureReceipt, type CheckpointCounts, type CheckpointCoverage, type CheckpointManifest,
} from "./checkpoint.js";
import {
  AuthorityCoordinator, canonicalDestination, signActivationReceipt, type ActivationReceipt, type AuthorityView, type OwnerAuthority, type StagingRecord,
} from "./coordinator.js";
import { resolveCatalog, type OperationPin } from "./devices.js";
import { readSourceAuthority } from "./doctor.js";
import type { SnapshotKey } from "./envelope.js";
import { OperationsError, fail } from "./errors.js";
import { OwnedPaths, absentTarget, entry, noSidecars, readBounded, syncDirectory, withOwnedCleanup } from "./files.js";
import { checkFullSchema, contextSchemaLabel, type FullKind } from "./full-schemas.js";
import { GIT_PREFIX } from "./git.js";
import { resolveLimits, sha256, type SnapshotLimits } from "./manifest.js";
import { checkIntegrity, openReadOnly, sameIdentity, type Identity } from "./schemas.js";

/**
 * The open store a trusted maintenance quiesce lends to this controller (structural view of `HostStore`). The
 * controller never closes it: the host's own shutdown does, after its drain.
 */
export interface MaintenanceStore {
  readonly databasePath: string;
  readonly hostId: string;
  readonly ownerId: string;
  authorityStatus(): HostAuthorityStatus;
  checkpointForTransfer(checkpointId: string): { epoch: number; checkpointId: string; directory: string };
  withCheckpointFence<T>(checkpointId: string, operation: () => T): T;
  revokeForTransfer(checkpointId: string, binding: { artifactSha256: string; targetSha256: string }): HostAuthorityStatus;
  abortCheckpoint(checkpointId: string): HostAuthorityStatus;
}
/**
 * Trusted, owner-local operations port matching the HostServices seam chosen by its owner:
 * `quiesceForMaintenance()` permanently closes admission synchronously, drains the runtime and the real
 * auxiliaries, and resolves with the still-open, still-leased store only after that drain completed; it rejects
 * (and keeps the store and lease) when the drain is incomplete. Local only — never HTTP, MCP or an engine tool.
 */
export interface MaintenanceQuiescePort {
  quiesceForMaintenance(options?: { graceMs?: number }): Promise<MaintenanceStore>;
}

export interface MaintenanceHold { readonly store: MaintenanceStore; readonly authority: HostAuthorityStatus; readonly dataDir: string }
export interface PreparedCheckpoint { checkpointId: string; epoch: number; artifact: CheckpointCaptureReceipt }
export interface ActivationResult {
  checkpointId: string; destination: string; epoch: number; resumed: boolean; counts: CheckpointCounts; coverage: CheckpointCoverage;
  excludedPresent: string[]; hub: HostAuthorityActivationReport | "already_published"; registryOffersCancelled: number; registryClaimsClosed: number;
}

const view = (status: { installationId: string; ownerId: string; epoch: number; state: string; directory: string; checkpointId: string | null }): AuthorityView => ({
  installationId: status.installationId, ownerId: status.ownerId, epoch: status.epoch, state: status.state as AuthorityView["state"], directory: status.directory, checkpointId: status.checkpointId,
});
const newCheckpointId = (): string => `ckp_${randomBytes(18).toString("base64url")}`;

export interface ControllerOptions { coordinator: AuthorityCoordinator; clock?: () => number }
export interface CaptureOptions { key: SnapshotKey; output: string; operationCatalog?: readonly OperationPin[]; limits?: Partial<SnapshotLimits> }
export interface ActivateOptions { artifact: string; key: SnapshotKey; receipt: ActivationReceipt; operationCatalog?: readonly OperationPin[]; limits?: Partial<SnapshotLimits> }

/**
 * Owner-local authority workflow over one coordinator. Every step is explicit and individually retryable:
 * quiesce → prepare (checkpoint + capture) → revokeSource → issueReceipt → activate, or abort / backup.
 */
export class LocalAuthorityController {
  readonly coordinator: AuthorityCoordinator;
  readonly #clock: () => number;
  constructor(options: ControllerOptions) {
    if (!(options?.coordinator instanceof AuthorityCoordinator)) fail("invalid_input", "a coordinator is required");
    this.coordinator = options.coordinator; this.#clock = options.clock ?? Date.now;
  }
  #now(): number { const now = this.#clock(); if (!Number.isSafeInteger(now) || now < 0) fail("invalid_input", "clock must return epoch milliseconds"); return now; }
  /**
   * Runs `work` that owns the reserved staging; afterwards, a staging whose path is gone (success, or a failure that
   * cleaned up) is recorded removed. One that is still present — a cleanup failure, or a crash, which never reaches
   * here — stays reserved for `recoverStaging`.
   */
  #withStaging<T>(reserved: StagingRecord, work: () => T): T {
    const settle = (): void => { if (!entry(join(reserved.parent, reserved.name))) this.coordinator.recordStagingRemoved(reserved.stagingId, this.#now()); };
    let result: T;
    try { result = work(); }
    catch (error) { try { settle(); } catch { /* the original failure wins; the staging stays reserved */ } throw error; }
    settle();
    return result;
  }

  /**
   * Borrows the store from the host's trusted quiesce. A rejected quiesce (incomplete drain) propagates and nothing
   * changes. The lent store must be the active, directory-bound authority this coordinator knows.
   */
  async quiesce(host: MaintenanceQuiescePort, graceMs?: number): Promise<MaintenanceHold> {
    if (!host || typeof host.quiesceForMaintenance !== "function") fail("fence_unavailable", "a trusted maintenance quiesce port is required");
    const store = await host.quiesceForMaintenance(graceMs === undefined ? {} : { graceMs });
    const authority = store.authorityStatus();
    const dataDir = dirname(store.databasePath);
    if (authority.state !== "active" || authority.directory !== realpathSync(dataDir) || authority.installationId !== store.hostId || authority.ownerId !== store.ownerId) {
      fail("authority_unavailable", "quiesced store is not the active authority of its directory");
    }
    this.coordinator.enroll(view(authority), this.#now());
    return { store, authority, dataDir };
  }

  /**
   * Checkpoint and capture under the held store. On a refused checkpoint (work still running: the drain was not
   * complete) the coordinator returns to active at the same epoch and nothing was captured. A failure after the
   * checkpoint leaves it held: retry `prepare`'s capture with `captureHeld`, or `abort` it explicitly.
   */
  prepare(hold: MaintenanceHold, options: CaptureOptions): PreparedCheckpoint {
    // Requirements that need no capture are checked before the checkpoint: a device surface needs the trusted
    // operation catalog, the output must be a fresh name, and limits must be valid.
    if (options.operationCatalog !== undefined || entry(join(hold.dataDir, CHECKPOINT_SOURCE_FILES.deviceSurface))) resolveCatalog(options.operationCatalog);
    resolveLimits(options.limits); absentTarget(options.output);
    const checkpointId = newCheckpointId();
    this.coordinator.beginCheckpoint(view(hold.authority), checkpointId, this.#now());
    let checkpoint: { epoch: number; checkpointId: string; directory: string };
    try { checkpoint = hold.store.checkpointForTransfer(checkpointId); }
    catch (error) {
      this.coordinator.cancelUnstarted(checkpointId, view(hold.store.authorityStatus()), this.#now());
      throw error;
    }
    return { checkpointId, epoch: checkpoint.epoch, artifact: this.captureHeld(hold, checkpointId, options) };
  }

  /** Capture (or recapture after a failed attempt) under a checkpoint this hold already owns. */
  captureHeld(hold: MaintenanceHold, checkpointId: string, options: CaptureOptions): CheckpointCaptureReceipt {
    const status = hold.store.authorityStatus();
    if (status.state !== "checkpointed" || status.checkpointId !== checkpointId) fail("authority_unavailable", "checkpoint is not held");
    const { parent, name } = absentTarget(options.output);
    const reserved = this.coordinator.reserveStaging(checkpointId, "capture", parent, name, null, this.#now());
    const receipt = this.#withStaging(reserved, () => captureCheckpointArtifact({
      source: hold.store, checkpoint: { checkpointId, epoch: status.epoch, directory: status.directory }, key: options.key, output: options.output,
      ...(options.operationCatalog ? { operationCatalog: options.operationCatalog } : {}), ...(options.limits ? { limits: options.limits } : {}), clock: this.#clock,
      staging: { name: reserved.name, created: (ino) => this.coordinator.recordStagingCreated(reserved.stagingId, ino, this.#now()) },
    }));
    this.coordinator.recordCaptured(checkpointId, receipt.artifactSha256, receipt.manifestSha256, this.#now());
    return receipt;
  }

  /**
   * Backup: checkpoint, capture, then abort, so the source continues at the next epoch and the artifact can be
   * verified or inspected but can never be activated (its checkpoint is dead in the coordinator and stale in the Hub).
   */
  backup(hold: MaintenanceHold, options: CaptureOptions): PreparedCheckpoint & { resumedEpoch: number } {
    const prepared = this.prepare(hold, options);
    const aborted = this.abort({ store: hold.store }, prepared.checkpointId);
    return { ...prepared, resumedEpoch: aborted.epoch };
  }

  /**
   * Persists the permanent source revocation bound to the captured artifact and the chosen destination, then reads
   * it back from the source database through an independent read-only handle before the coordinator records it.
   * Without a borrowed store the source is reopened in checkpoint recovery mode (lease, exact checkpoint only).
   */
  revokeSource(source: { store: MaintenanceStore } | { dataDir: string }, checkpointId: string, destination: string): AuthorityView {
    const record = this.coordinator.checkpoint(checkpointId);
    if (record.artifactSha256 === null) fail("authority_unavailable", "checkpoint has no captured artifact");
    const target = this.coordinator.target(checkpointId, destination);
    const dataDir = "store" in source ? dirname(source.store.databasePath) : source.dataDir;
    if (realpathSync(dataDir) !== record.sourceDirectory) fail("identity_mismatch", "source directory is not the checkpointed one");
    const binding = { artifactSha256: record.artifactSha256!, targetSha256: target };
    if ("store" in source) source.store.revokeForTransfer(checkpointId, binding);
    else {
      const persisted = readSourceAuthority(dataDir);
      if (!(persisted.state === "revoked" && persisted.checkpointId === checkpointId)) {
        const store = new HostStore({ dataDir, authorityRecovery: { checkpointId } });
        try { store.revokeForTransfer(checkpointId, binding); } finally { store.close(); }
      }
    }
    const persisted = readSourceAuthority(dataDir);
    this.coordinator.recordRevoked(checkpointId, destination, persisted, this.#now());
    return view(persisted);
  }

  /** Owner abort before revocation (source back to active at epoch + 1). */
  abort(source: { store: MaintenanceStore } | { dataDir: string }, checkpointId: string): AuthorityView {
    const dataDir = "store" in source ? dirname(source.store.databasePath) : source.dataDir;
    const before = readSourceAuthority(dataDir);
    if (!(before.state === "active" && before.epoch === this.coordinator.checkpoint(checkpointId).epoch + 1)) {
      if ("store" in source) source.store.abortCheckpoint(checkpointId);
      else {
        const store = new HostStore({ dataDir, authorityRecovery: { checkpointId } });
        try { store.abortCheckpoint(checkpointId); } finally { store.close(); }
      }
    }
    const after = readSourceAuthority(dataDir);
    this.coordinator.abort(checkpointId, view(after), this.#now());
    return view(after);
  }

  /** The owner signs inside the injected signer; the receipt binds every field the coordinator recorded. */
  issueReceipt(owner: OwnerAuthority, checkpointId: string, ttlMs = 10 * 60_000): ActivationReceipt {
    return signActivationReceipt(owner, this.coordinator.receiptBody(checkpointId, this.#now(), ttlMs));
  }

  /**
   * Activates the receipted artifact into its new canonical directory. Everything that can be checked without an
   * irreversible step comes first: artifact hash, per-member quota, authenticated decryption and strict decode (a
   * wrong or oversized artifact never consumes the receipt); the local source revocation read back; the trusted
   * operation catalog when a device surface is included; the receipt verified WITHOUT consuming it; then every store
   * staged into a coordinator-reserved private staging (name reserved, inode recorded, before any plaintext is
   * written) and validated exactly against the manifest. Only then is the nonce consumed (CAS). After it: the
   * destination is reserved create-only in its parent (`activationReservationPath`), created, marked and journaled;
   * the Hub authority moves to epoch + 1 bound to the destination; everything else is linked create-only and the Hub
   * database last as the commit point; markers cleared; coordinator CAS. A retry with the same receipt resumes a
   * crashed attempt (a new staging; the crashed one stays reserved for `recoverStaging`); nothing else can.
   */
  activate(options: ActivateOptions): ActivationResult {
    const { receipt } = options;
    const limits = resolveLimits(options.limits);
    const body = receipt?.body;
    if (!body) fail("authentication_failed", "receipt is required");
    const opened = openCheckpointArtifact(options.artifact, options.key, options.limits);
    const manifest = opened.manifest;
    if (opened.artifactSha256 !== body.artifactSha256 || opened.manifestSha256 !== body.manifestSha256 || manifest.source.checkpointId !== body.checkpointId
      || manifest.source.epoch !== body.sourceEpoch || manifest.source.installationId !== body.installationId || manifest.source.ownerId !== body.ownerId
      || manifest.source.directory !== body.sourceDirectory) fail("authentication_failed", "receipt does not bind this artifact");
    const destination = canonicalDestination(body.destination);
    if (entry(body.sourceDirectory)?.isDirectory()) {
      const source = readSourceAuthority(body.sourceDirectory);
      if (source.state !== "revoked" || source.checkpointId !== body.checkpointId || source.revokedArtifact !== body.artifactSha256 || source.revokedTarget !== body.targetSha256) {
        fail("authority_unavailable", "source revocation is not persisted");
      }
    }
    const catalog = manifest.coverage.deviceSurface === "included" ? resolveCatalog(options.operationCatalog) : null;
    const admitted = this.coordinator.verifyReceipt(receipt, this.#now());
    const receiptHash = admitted.receiptSha256;
    const finished = (result: Omit<ActivationResult, "checkpointId" | "counts" | "coverage" | "excludedPresent">): ActivationResult => ({
      checkpointId: body.checkpointId, counts: manifest.counts, coverage: manifest.coverage, excludedPresent: manifest.excluded.present, ...result,
    });
    const reservation = activationReservationPath(destination);
    const marker = join(destination, ACTIVATION_MARKER_FILE);
    const markerBody = `${JSON.stringify({ checkpointId: body.checkpointId })}\n`;
    const committed = (destinationIno: string | null): AuthorityView | null => {
      if (!entry(join(destination, "dexter.sqlite"))) return null;
      const activated = readSourceAuthority(destination);
      if (activated.state !== "active" || activated.epoch !== body.sourceEpoch + 1 || activated.activationReceipt !== receiptHash
        || activated.directory !== destination || activated.provenance !== "activation"
        || (destinationIno !== null && activated.directoryIno !== destinationIno)) {
        fail("authority_unavailable", "destination does not hold this activation");
      }
      return view(activated);
    };
    // Lost response after the commit point: the destination already holds exactly this activation. Nothing staged.
    if (admitted.resume && entry(join(destination, "dexter.sqlite"))) {
      const consumed = this.coordinator.consumeReceipt(receipt, this.#now());
      const done = committed(consumed.checkpoint.destinationIno)!;
      clearMarker(marker, markerBody); clearMarker(reservation, markerBody);
      this.coordinator.recordActivated(body.checkpointId, consumed.attemptToken, done, this.#now());
      return finished({ destination, epoch: done.epoch, resumed: true, hub: "already_published", registryOffersCancelled: 0, registryClaimsClosed: 0 });
    }
    const identity: Identity = { ownerId: manifest.source.ownerId, installationId: manifest.source.installationId };
    const kinds = (["hub", ...CHECKPOINT_COMPONENTS] as FullKind[]).filter((kind) => kind === "hub" || manifest.coverage[kind as typeof CHECKPOINT_COMPONENTS[number]] === "included");

    const reserved = this.coordinator.reserveStaging(body.checkpointId, "activation", dirname(destination), basename(destination), receiptHash, this.#now());
    const staging = join(reserved.parent, reserved.name);
    const owned = new OwnedPaths();
    return this.#withStaging(reserved, () => withOwnedCleanup(owned, () => {
      owned.mkdir(staging);
      this.coordinator.recordStagingCreated(reserved.stagingId, lstatSync(staging, { bigint: true }).ino.toString(), this.#now());
      const staged = (kind: FullKind): string => join(staging, CHECKPOINT_MEMBERS[kind]);
      for (const kind of kinds) owned.write(staged(kind), opened.members.get(CHECKPOINT_MEMBERS[kind])!);
      const gitMembers = new Map([...opened.members].filter(([name]) => name.startsWith(GIT_PREFIX)));
      const dbs: Partial<Record<FullKind, DatabaseSync>> = {};
      try {
        for (const kind of kinds) {
          noSidecars(staged(kind));
          const db = openReadOnly(staged(kind)); dbs[kind] = db;
          if (!sameIdentity(checkFullSchema(db, kind), identity)) fail("identity_mismatch", `${kind} member belongs to another installation`);
          if(kind==="context"&&contextSchemaLabel(db)!==manifest.schemas.context)
            fail("unsupported_schema","context manifest label does not match its exact catalog");
          checkIntegrity(db, kind);
        }
        checkCheckpointAuthority(dbs.hub!, manifest.source);
        const validated = validateCheckpointStores(dbs, manifest.coverage.context === "included" ? gitSnapshotOf(gitMembers, limits) : null, identity, catalog);
        if (JSON.stringify(validated.counts) !== JSON.stringify(manifest.counts) || JSON.stringify(validated.reconciliation) !== JSON.stringify(manifest.reconciliation)) {
          fail("corrupt", "restored counts do not match the manifest");
        }
      } finally { for (const db of Object.values(dbs)) db.close(); }
      if (manifest.coverage.context === "included") stageContextRepository(owned, join(staging, CONTEXT_REPOSITORY), gitMembers, limits);

      // Irreversible: the nonce is consumed only now, after everything above validated.
      const consumed = this.coordinator.consumeReceipt(receipt, this.#now());
      const activatedAt = consumed.checkpoint.activatedAt!;
      if (consumed.resumed) {
        const done = committed(consumed.checkpoint.destinationIno);
        if (done) {
          clearMarker(marker, markerBody); clearMarker(reservation, markerBody);
          this.coordinator.recordActivated(body.checkpointId, consumed.attemptToken, done, this.#now());
          if (!owned.cleanup()) throw new OperationsError("cleanup_incomplete", "activated, but activation staging was not fully removed");
          return finished({ destination, epoch: done.epoch, resumed: true, hub: "already_published", registryOffersCancelled: 0, registryClaimsClosed: 0 });
        }
      }

      // Destination reservation in the parent BEFORE the directory exists (closes the mkdir -> marker window).
      writeMarker(reservation, markerBody);
      const existing = entry(destination);
      if (existing && (!consumed.resumed || existing.isSymbolicLink() || !existing.isDirectory())) fail("destination_exists", "destination already exists");
      if (!existing) { mkdirSync(destination, { mode: 0o700 }); syncDirectory(dirname(destination)); }
      writeMarker(marker, markerBody);
      const directoryIno = statSync(destination, { bigint: true }).ino.toString();
      if (consumed.resumed && consumed.checkpoint.destinationIno !== null && consumed.checkpoint.destinationIno !== directoryIno) fail("destination_exists", "destination was replaced");
      this.coordinator.recordDestination(body.checkpointId, consumed.attemptToken, directoryIno, this.#now());
      const canonical = realpathSync(destination);
      if (canonical !== destination) fail("unsafe_path", "destination is not canonical");

      // Authority and transport trust of the copy, applied to the staged files only.
      let registryOffersCancelled = 0; let registryClaimsClosed = 0;
      for (const kind of ["deviceRegistry", "appClients"] as const) {
        if (!kinds.includes(kind)) continue;
        const closed = closePairing(staged(kind), activatedAt);
        registryOffersCancelled += closed.offers; registryClaimsClosed += closed.claims;
      }
      const hubDestination = join(destination, "dexter.sqlite");
      if (entry(hubDestination)) fail("destination_exists", "destination already holds a Hub database");
      const hub = HostStore.activateCheckpointCopy(staged("hub"), {
        installationId: identity.installationId, ownerId: identity.ownerId, checkpointId: body.checkpointId, sourceEpoch: body.sourceEpoch,
        directory: canonical, directoryIno, receiptSha256: receiptHash, activatedAt,
      });
      for (const kind of kinds) {
        noSidecars(staged(kind));
        const db = openReadOnly(staged(kind));
        try { if (!sameIdentity(checkFullSchema(db, kind), identity)) fail("identity_mismatch", "activated copy changed identity"); checkIntegrity(db, kind); } finally { db.close(); }
      }

      // Publication: everything but the Hub, create-only; a resumed attempt keeps only byte-identical entries.
      const publish = (from: string, to: string): void => {
        const present = entry(to);
        if (present) {
          if (!consumed.resumed || present.isSymbolicLink() || !present.isFile() || sha256(readBounded(to, limits.maxDatabaseBytes)) !== sha256(readBounded(from, limits.maxDatabaseBytes))) {
            fail("destination_exists", "destination holds an entry this activation did not stage");
          }
          return;
        }
        const source = owned.entries().find((item) => item.path === from && !item.directory);
        if (!source) fail("unsafe_path", "staged entry is not owned");
        const link = new OwnedPaths(); link.link(source!, to); link.forgetAll();
      };
      if (kinds.includes("relayConsumer") || kinds.includes("relayAssociations")) {
        const relayHost = join(destination, RELAY_HOST_DIRECTORY);
        const present = entry(relayHost);
        if (present && (!consumed.resumed || present.isSymbolicLink() || !present.isDirectory())) fail("destination_exists", "destination holds an entry this activation did not stage");
        if (!present) { mkdirSync(relayHost, { mode: 0o700 }); syncDirectory(destination); }
      }
      for (const kind of kinds) if (kind !== "hub") publish(staged(kind), join(destination, sourceName(kind)));
      if (entry(join(destination, RELAY_HOST_DIRECTORY))) syncDirectory(join(destination, RELAY_HOST_DIRECTORY));
      if (manifest.coverage.context === "included") {
        const repository = join(staging, CONTEXT_REPOSITORY);
        const directories = owned.entries().filter((item) => item.directory && item.path.startsWith(`${repository}`)).map((item) => item.path);
        for (const directory of directories) {
          const target = join(destination, directory.slice(staging.length + 1));
          const present = entry(target);
          if (present) { if (!consumed.resumed || present.isSymbolicLink() || !present.isDirectory()) fail("destination_exists", "destination holds an entry this activation did not stage"); continue; }
          mkdirSync(target, { mode: 0o700 });
        }
        for (const item of owned.entries().filter((candidate) => !candidate.directory && candidate.path.startsWith(`${repository}/`))) {
          publish(item.path, join(destination, item.path.slice(staging.length + 1)));
        }
        for (const directory of [...directories].reverse()) syncDirectory(join(destination, directory.slice(staging.length + 1)));
      }
      syncDirectory(destination);
      // Commit point: the Hub database, linked last. Before it exists the directory is an incomplete activation that
      // no store opens or bootstraps; after it, only a retry with this receipt can complete the record.
      publish(staged("hub"), hubDestination);
      syncDirectory(destination);
      clearMarker(marker, markerBody);
      clearMarker(reservation, markerBody);
      const activated = committed(directoryIno)!;
      this.coordinator.recordActivated(body.checkpointId, consumed.attemptToken, activated, this.#now());
      if (!owned.cleanup()) throw new OperationsError("cleanup_incomplete", "activated, but activation staging was not fully removed");
      return finished({ destination: canonical, epoch: activated.epoch, resumed: consumed.resumed, hub, registryOffersCancelled, registryClaimsClosed });
    }));
  }
}

const sourceName = (kind: FullKind): string => CHECKPOINT_SOURCE_FILES[kind];

/** Create-only, fsynced marker; an existing one must be this activation's own. */
function writeMarker(path: string, body: string): void {
  const present = entry(path);
  if (present) {
    if (present.isSymbolicLink() || !present.isFile() || readBounded(path, 1024).toString("utf8") !== body) fail("destination_exists", "destination holds another activation");
    return;
  }
  const fd = openSync(path, "wx", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
/** Removes this activation's own marker after the commit point; anything else under that name is refused. */
function clearMarker(path: string, body: string): void {
  const present = entry(path);
  if (!present) return;
  if (present.isSymbolicLink() || !present.isFile() || readBounded(path, 1024).toString("utf8") !== body) fail("destination_exists", "destination holds another activation");
  unlinkSync(path);
  syncDirectory(dirname(path));
}

/** Pairing that was open at the source cannot be completed with the copy: offers cancelled, pending claims closed. */
function closePairing(path: string, at: number): { offers: number; claims: number } {
  noSidecars(path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("BEGIN IMMEDIATE");
    try {
      const offers = Number(db.prepare("UPDATE offers SET status = 'cancelled', updated_at = ? WHERE status = 'open'").run(at).changes);
      const claims = Number(db.prepare("UPDATE claims SET status = 'rejected', decided_at = ? WHERE status = 'pending'").run(at).changes)
        + Number(db.prepare("UPDATE claims SET status = 'failed', decided_at = ? WHERE status = 'approving'").run(at).changes);
      db.exec("COMMIT");
      return { offers, claims };
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

const GIT_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";
/**
 * Rebuilds `context-revisions/` for `ContextRepository`: `.git` with HEAD, master ref, the verified loose objects and
 * a config written here (never copied), plus master's working tree, which `ContextRepository.read` compares with Git.
 */
function stageContextRepository(owned: OwnedPaths, root: string, members: ReadonlyMap<string, Buffer>, limits: SnapshotLimits): void {
  const dirs = new Set<string>();
  const ensure = (path: string): void => {
    if (dirs.has(path) || path === dirname(root)) return;
    ensure(dirname(path));
    owned.mkdir(path); dirs.add(path);
  };
  ensure(root); ensure(join(root, ".git"));
  for (const sub of ["objects", "refs", "refs/heads", "refs/tags"]) ensure(join(root, ".git", sub));
  owned.write(join(root, ".git", "config"), Buffer.from(GIT_CONFIG));
  for (const [name, bytes] of members) {
    const path = join(root, ".git", name.slice(GIT_PREFIX.length));
    ensure(dirname(path));
    owned.write(path, bytes);
  }
  for (const [path, bytes] of contextWorkingTree(members, limits)) {
    const target = join(root, path);
    ensure(dirname(target));
    owned.write(target, bytes);
  }
}

export type { CheckpointManifest };
