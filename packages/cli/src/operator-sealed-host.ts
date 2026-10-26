import { readHubIdentity, readSourceAuthority, runCli } from "@dexter/operations";
import type { CliDependencies } from "@dexter/operations";
import { planHostStartup, type HostStartupInput } from "./host-startup.js";
import type { HostServices } from "./host-services.js";
import { OperatorSealedCustody, SealedCustodyError } from "./operator-sealed-custody.js";

/** Static local embedding. Unlock happens first, then all normal startup preflight, then ONE canonical host writer.
 * The explicit normal enable flags remain required. No remote commands, env, module loaders or implicit relay.
 * Before successful open(), custody ownership remains with the caller. A failure in identity reading or preflight
 * leaves it unlocked: the caller must close() (or lock() for a later retry) after confirming no host was opened.
 * An uncertain open() failure may retain a writer/quarantined runtime: do not automatically lock or release custody;
 * the caller must reconcile/drain that lifecycle first. Shutdown failure similarly retains custody for writer/drain. */
export function openOperatorSealedHost(custody: OperatorSealedCustody, input: HostStartupInput): { host: HostServices; shutdown(): Promise<void> } {
  const description = custody.toJSON();
  if (!description.unlocked || !description.identity) throw new SealedCustodyError("locked");
  const identity = readHubIdentity(input.options.dataDir), authority = readSourceAuthority(input.options.dataDir);
  if (identity.installationId !== description.binding.installationId || identity.ownerId !== description.binding.ownerId || authority.state !== "active") throw new SealedCustodyError("authentication_failed");
  const tls = custody.tlsIdentity();
  const options = { ...input.options,
    ...(input.options.appClients ? { appClients: { ...input.options.appClients, identity: tls } } : {}),
    ...(input.options.devices ? { devices: { ...input.options.devices, identity: tls } } : {}) };
  const relay = input.providers?.relay;
  if (relay && (relay.custodyMode !== "operator-sealed-exportable" || relay.custody.kind !== "operator_sealed_exportable" || JSON.stringify(relay.recipient) !== JSON.stringify(description.identity.publicPin))) throw new SealedCustodyError("authentication_failed");
  const providers = { ...input.providers, ...(relay ? { relay: { ...relay, custody: custody.relay(), custodyMode: "operator-sealed-exportable" as const } } : {}) };
  const host = planHostStartup({ ...input, options, providers }).open();
  let shutdown: Promise<void> | null = null;
  return Object.freeze({ host, shutdown: () => shutdown ??= (async () => { await host.shutdown(); await custody.close(); })() });
}

/** Owner-local operations use the actual shipped runCli and concrete custody adapters. No authority or writer is
 * automatically created by exporting keys. The caller owns unlock/lock and supplies only the existing CLI args. */
export async function runOperatorSealedOperations(custody: OperatorSealedCustody, argv: readonly string[], dependencies: Omit<CliDependencies, "custody">): Promise<number> {
  return runCli(argv, { ...dependencies, custody: custody.operations() });
}
