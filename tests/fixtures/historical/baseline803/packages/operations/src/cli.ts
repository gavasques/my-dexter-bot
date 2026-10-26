import { writeFileSync } from "node:fs";
import { HostError } from "@dexter/hub";
import { currentOperationCatalog } from "./catalog.js";
import { CHECKPOINT_FORMAT_VERSION, openCheckpointArtifact } from "./checkpoint.js";
import { AuthorityCoordinator, COORDINATOR_SCHEMA, type ActivationReceipt } from "./coordinator.js";
import { resolveCatalog, type OperationPin } from "./devices.js";
import { UNAVAILABLE_CUSTODY, requireOwnerSigner, requireSnapshotKey, type CustodyProvider } from "./custody.js";
import { doctor } from "./doctor.js";
import { OperationsError, fail } from "./errors.js";
import { existingFile, readBounded } from "./files.js";
import { OfflineMaintenance, upgradeLegacyInstallation } from "./maintenance.js";
import { SNAPSHOT_VERSION } from "./manifest.js";
import { recoverStaging } from "./staging.js";
import { LocalAuthorityController } from "./transfer.js";

/**
 * `dexter-ops`: the owner-local operator command line for the stopped-host flow. Every command prints exactly one
 * JSON line holding only states, versions, counts, ids and digests — never key material, receipts' signatures, row
 * content, paths, native cursors or raw error text; a failure prints only its code. Commands that need custody take
 * it from the injected provider; the shipped binary injects none, so they fail closed with `authority_unavailable`.
 * A running host is refused by the writer lease (`host_host_locked`); online maintenance of a running host goes
 * through the host's own `quiesceForMaintenance()` seam and `LocalAuthorityController`, never through this binary.
 */
export const OPERATIONS_CLI_VERSION = "g8-authority-r7";
export const HUB_AUTHORITY_SCHEMA = 4;
const RECEIPT_MAX_BYTES = 64 * 1024;

/**
 * `operationCatalog` is the trusted device operation catalog of the embedding (typed, never read from flags or files);
 * without it the command line uses this build's own `currentOperationCatalog()`. Prepare/backup and activate use the
 * same catalog, and it is validated before any checkpoint, staging or receipt consumption.
 */
export interface CliDependencies { write(line: string): void; custody?: CustodyProvider; clock?: () => number; operationCatalog?: readonly OperationPin[] }
type Flags = Record<string, string>;

const USAGE: Record<string, readonly string[]> = {
  "version": [],
  "doctor": ["data-dir"],
  "coordinator init": ["coordinator", "owner-id"],
  "coordinator status": ["coordinator"],
  "upgrade": ["data-dir", "coordinator"],
  "backup": ["data-dir", "coordinator", "output"],
  "transfer prepare": ["data-dir", "coordinator", "output"],
  "transfer abort": ["data-dir", "coordinator", "checkpoint"],
  "transfer revoke": ["data-dir", "coordinator", "checkpoint", "destination"],
  "transfer receipt": ["coordinator", "checkpoint", "output"],
  "transfer activate": ["coordinator", "artifact", "receipt"],
  "artifact inspect": ["artifact"],
  "staging recover": ["coordinator", "staging"],
};

function parse(argv: readonly string[]): { command: string; flags: Flags } {
  const words: string[] = [];
  let index = 0;
  while (index < argv.length && !argv[index]!.startsWith("--")) words.push(argv[index++]!);
  const command = words.join(" ");
  const required = USAGE[command];
  if (!required) fail("invalid_input", "unknown command");
  const flags: Flags = {};
  for (; index < argv.length; index += 2) {
    const name = argv[index]!.slice(2); const value = argv[index + 1];
    if (!argv[index]!.startsWith("--") || !required!.includes(name) || Object.hasOwn(flags, name) || value === undefined || value.startsWith("--") || value.length === 0) {
      fail("invalid_input", "invalid flags");
    }
    flags[name] = value!;
  }
  if (required!.some((name) => !Object.hasOwn(flags, name))) fail("invalid_input", "missing flags");
  return { command, flags };
}

function errorCode(error: unknown): string {
  if (error instanceof OperationsError) return error.code;
  if (error instanceof HostError) return `host_${error.code}`;
  return "internal";
}

function readReceipt(path: string): ActivationReceipt {
  let value: unknown;
  try { value = JSON.parse(readBounded(existingFile(path), RECEIPT_MAX_BYTES).toString("utf8")); }
  catch (error) { if (error instanceof OperationsError) throw error; return fail("authentication_failed", "receipt is not valid JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "body,signature") fail("authentication_failed", "receipt is not valid");
  return value as ActivationReceipt;
}

async function execute(command: string, flags: Flags, deps: CliDependencies): Promise<Record<string, unknown>> {
  const custody = deps.custody ?? UNAVAILABLE_CUSTODY;
  const clock = deps.clock ?? Date.now;
  const operationCatalog = deps.operationCatalog ?? currentOperationCatalog();
  const withCoordinator = <T>(fn: (coordinator: AuthorityCoordinator) => T | Promise<T>): Promise<T> => {
    const coordinator = AuthorityCoordinator.open(flags.coordinator!);
    return Promise.resolve().then(() => fn(coordinator)).finally(() => coordinator.close());
  };
  switch (command) {
    case "version":
      return {
        operations: OPERATIONS_CLI_VERSION, hubSchema: HUB_AUTHORITY_SCHEMA, checkpointFormat: CHECKPOINT_FORMAT_VERSION, inspectionFormat: SNAPSHOT_VERSION,
        coordinatorSchema: COORDINATOR_SCHEMA, operationCatalog: resolveCatalog(operationCatalog).size,
      };
    case "doctor": return { doctor: doctor(flags["data-dir"]!) };
    case "coordinator init": {
      const signer = requireOwnerSigner(custody, "enroll_owner");
      const coordinator = AuthorityCoordinator.open(flags.coordinator!, { ownerId: flags["owner-id"]!, ownerPublicKey: signer.publicKey });
      try { return { coordinatorId: coordinator.coordinatorId }; } finally { coordinator.close(); }
    }
    case "coordinator status": return withCoordinator((coordinator) => ({ coordinator: coordinator.status() }));
    case "upgrade": return withCoordinator((coordinator) => ({ upgrade: upgradeLegacyInstallation(flags["data-dir"]!, coordinator, clock()) }));
    case "backup":
    case "transfer prepare": {
      const key = requireSnapshotKey(custody, "capture");
      resolveCatalog(operationCatalog);
      return withCoordinator(async (coordinator) => {
        const controller = new LocalAuthorityController({ coordinator, clock });
        const maintenance = new OfflineMaintenance(flags["data-dir"]!);
        try {
          const hold = await controller.quiesce(maintenance);
          let prepared;
          try {
            const options = { key, output: flags.output!, operationCatalog };
            prepared = command === "backup" ? controller.backup(hold, options) : controller.prepare(hold, options);
          } catch (error) {
            // A capture that failed after the checkpoint is aborted (source active at the next epoch, nothing published).
            const status = maintenance.store.authorityStatus();
            if (status.state === "checkpointed" && status.checkpointId !== null) controller.abort({ store: maintenance.store }, status.checkpointId);
            throw error;
          }
          const artifact = prepared.artifact;
          return {
            checkpointId: prepared.checkpointId, sourceEpoch: prepared.epoch, artifactSha256: artifact.artifactSha256, manifestSha256: artifact.manifestSha256,
            coverage: artifact.coverage, excludedPresent: artifact.excludedPresent, counts: artifact.counts, members: artifact.members,
            ...("resumedEpoch" in prepared ? { resumedEpoch: prepared.resumedEpoch, activatable: false } : {}),
          };
        } finally { maintenance.close(); }
      });
    }
    case "transfer abort":
      return withCoordinator((coordinator) => ({ authority: safeView(new LocalAuthorityController({ coordinator, clock }).abort({ dataDir: flags["data-dir"]! }, flags.checkpoint!)) }));
    case "transfer revoke":
      return withCoordinator((coordinator) => ({ authority: safeView(new LocalAuthorityController({ coordinator, clock }).revokeSource({ dataDir: flags["data-dir"]! }, flags.checkpoint!, flags.destination!)) }));
    case "transfer receipt": {
      const signer = requireOwnerSigner(custody, "sign_receipt");
      return withCoordinator((coordinator) => {
        const receipt = new LocalAuthorityController({ coordinator, clock }).issueReceipt(signer, flags.checkpoint!);
        // A signed, non-secret statement; written create-only and private.
        writeFileSync(flags.output!, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
        return { checkpointId: receipt.body.checkpointId, sourceEpoch: receipt.body.sourceEpoch, expiresAt: receipt.body.expiresAt };
      });
    }
    case "transfer activate": {
      const key = requireSnapshotKey(custody, "activate");
      resolveCatalog(operationCatalog);
      const receipt = readReceipt(flags.receipt!);
      return withCoordinator((coordinator) => {
        const result = new LocalAuthorityController({ coordinator, clock }).activate({ artifact: flags.artifact!, key, receipt, operationCatalog });
        return {
          checkpointId: result.checkpointId, epoch: result.epoch, resumed: result.resumed, coverage: result.coverage, counts: result.counts,
          excludedPresent: result.excludedPresent, hub: result.hub, registryOffersCancelled: result.registryOffersCancelled, registryClaimsClosed: result.registryClaimsClosed,
        };
      });
    }
    case "staging recover":
      return withCoordinator((coordinator) => ({ staging: recoverStaging(coordinator, flags.staging!, clock()) }));
    case "artifact inspect": {
      const opened = openCheckpointArtifact(flags.artifact!, requireSnapshotKey(custody, "inspect"));
      const { manifest } = opened;
      return {
        artifactSha256: opened.artifactSha256, manifestSha256: opened.manifestSha256, format: manifest.format, version: manifest.version,
        source: { installationId: manifest.source.installationId, epoch: manifest.source.epoch, checkpointId: manifest.source.checkpointId },
        coverage: manifest.coverage, counts: manifest.counts, excluded: manifest.excluded, members: manifest.members.length, activatable: "only_with_owner_receipt",
      };
    }
    default: return fail("invalid_input", "unknown command");
  }
}

const safeView = (view: { installationId: string; epoch: number; state: string }): Record<string, unknown> => ({ installationId: view.installationId, epoch: view.epoch, state: view.state });

/** Runs one command; returns the process exit code (0 ok, 1 refused/failed, 2 usage). */
export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<number> {
  let parsed: { command: string; flags: Flags };
  try { parsed = parse(argv); } catch { deps.write(JSON.stringify({ ok: false, error: "usage" })); return 2; }
  try {
    const result = await execute(parsed.command, parsed.flags, deps);
    deps.write(JSON.stringify({ ok: true, command: parsed.command, ...result }));
    return 0;
  } catch (error) {
    deps.write(JSON.stringify({ ok: false, command: parsed.command, error: errorCode(error) }));
    return 1;
  }
}
