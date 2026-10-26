import { realpathSync } from "node:fs";
import { HostStore, SCHEMA_VERSION } from "@dexter/hub";
import type { AuthorityCoordinator } from "./coordinator.js";
import { readHubIdentity, readSourceAuthority } from "./doctor.js";
import { OperationsError, fail } from "./errors.js";
import type { MaintenanceQuiescePort, MaintenanceStore } from "./transfer.js";

/**
 * Offline maintenance of a stopped host. Opening the store takes the canonical writer lease, so a running host (any
 * process holding the lease) is refused with `host_locked` and nothing else can write while this is open. Opening
 * also turns whatever a crashed host left `running` into `unknown` — the Hub's own crash rule — and nothing is ever
 * re-run. There is therefore nothing to drain: the lent store is exactly the quiesced store the online
 * `quiesceForMaintenance()` seam lends. A checkpointed installation is reopened only for its exact checkpoint.
 */
export class OfflineMaintenance implements MaintenanceQuiescePort {
  readonly #store: HostStore;
  #closed = false;
  constructor(dataDir: string, recovery?: { checkpointId: string }) {
    this.#store = new HostStore(recovery ? { dataDir, authorityRecovery: recovery } : { dataDir });
  }
  get store(): HostStore { return this.#store; }
  quiesceForMaintenance(): Promise<MaintenanceStore> {
    return this.#closed ? Promise.reject(new OperationsError("authority_unavailable", "maintenance store is closed")) : Promise.resolve(this.#store);
  }
  /** Releases the lease. Possible in every authority state (active, checkpointed or revoked). */
  close(): void { if (!this.#closed) { this.#closed = true; this.#store.close(); } }
}

export interface LegacyUpgradeReport { fromVersion: number; toVersion: number; epoch: number; provenance: "legacy_upgrade"; resumed: boolean }

/**
 * Explicit, owner-local upgrade of a Hub written before schema 4 (no authority provenance). The coordinator first
 * reserves this installation for this canonical directory; a second copy of the same legacy installation elsewhere
 * is refused there, before anything is written. Only then is the store opened with the explicit bootstrap, which
 * migrates and binds the authority (epoch 1) to this directory's realpath and inode in one transaction. A retry
 * after a lost response finds the upgraded store and returns it. This is not reversible: older code refuses schema 4.
 */
export function upgradeLegacyInstallation(dataDir: string, coordinator: AuthorityCoordinator, now: number): LegacyUpgradeReport {
  const directory = realpathSync(dataDir);
  coordinator.assertOutside(directory);
  const identity = readHubIdentity(directory);
  if (identity.ownerId !== coordinator.ownerId) fail("identity_mismatch", "installation belongs to another owner");
  const reservation = { installationId: identity.installationId, ownerId: identity.ownerId, epoch: 1, state: "active" as const, directory, checkpointId: null };
  if (identity.schemaVersion >= 4) {
    const status = readSourceAuthority(directory);
    if (status.provenance !== "legacy_upgrade" || status.state !== "active" || status.epoch !== 1 || status.directory !== directory) {
      fail("authority_unavailable", "installation is not a completed legacy upgrade of this directory");
    }
    coordinator.enroll(reservation, now);
    return { fromVersion: identity.schemaVersion, toVersion: identity.schemaVersion, epoch: 1, provenance: "legacy_upgrade", resumed: true };
  }
  if (identity.schemaVersion < 1 || identity.schemaVersion > 3) fail("unsupported_schema", "database is not a legacy Hub");
  coordinator.enroll(reservation, now);
  const store = new HostStore({ dataDir: directory, ownerId: identity.ownerId, authorityBootstrap: "legacy_upgrade" });
  try {
    const status = store.authorityStatus();
    if (status.provenance !== "legacy_upgrade" || status.state !== "active" || status.epoch !== 1 || status.directory !== directory
      || status.installationId !== identity.installationId) fail("authority_unavailable", "upgraded authority disagrees with the reservation");
  } finally { store.close(); }
  return { fromVersion: identity.schemaVersion, toVersion: SCHEMA_VERSION, epoch: 1, provenance: "legacy_upgrade", resumed: false };
}
