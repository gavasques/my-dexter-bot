import type { OwnerAuthority } from "./coordinator.js";
import type { SnapshotKey } from "./envelope.js";
import { fail } from "./errors.js";

/**
 * Trusted, owner-local custody boundary. The snapshot encryption key and the owner's activation signer are opaque
 * capabilities: the key is lent synchronously per operation and the signer only returns signatures, so no secret
 * crosses into this package, an artifact, a receipt, a log or command output. The boundary is injected by the owner's
 * local embedding (never an engine, HTTP or MCP surface). Production custody (Keychain or a remote custody service)
 * is not part of this package and remains an external gate: the shipped command line has no provider and every
 * command that needs custody fails closed with `authority_unavailable`.
 */
export type CustodyPurpose = "capture" | "inspect" | "activate" | "sign_receipt" | "enroll_owner";
export interface CustodyProvider {
  /** The snapshot key capability, or null when this provider has none for the purpose. */
  snapshotKey(purpose: "capture" | "inspect" | "activate"): SnapshotKey | null;
  /** The owner signer capability (Ed25519), or null when this provider has none for the purpose. */
  ownerSigner(purpose: "sign_receipt" | "enroll_owner"): OwnerAuthority | null;
}

/** The provider of the shipped command line: no custody at all, so nothing that needs it can run. */
export const UNAVAILABLE_CUSTODY: CustodyProvider = Object.freeze({
  snapshotKey: (): SnapshotKey | null => null,
  ownerSigner: (): OwnerAuthority | null => null,
});

export function requireSnapshotKey(provider: CustodyProvider | undefined, purpose: "capture" | "inspect" | "activate"): SnapshotKey {
  const key = provider?.snapshotKey(purpose) ?? null;
  if (!key || typeof key.keyId !== "string" || typeof key.use !== "function") return fail("authority_unavailable", "snapshot key custody is unavailable");
  return key;
}

export function requireOwnerSigner(provider: CustodyProvider | undefined, purpose: "sign_receipt" | "enroll_owner"): OwnerAuthority {
  const signer = provider?.ownerSigner(purpose) ?? null;
  if (!signer || typeof signer.sign !== "function" || !signer.publicKey) return fail("authority_unavailable", "owner signing custody is unavailable");
  return signer;
}
