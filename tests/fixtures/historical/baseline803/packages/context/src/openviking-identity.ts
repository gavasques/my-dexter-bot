import { Buffer } from "node:buffer";

/** Mapper v1 is an injective UTF-8 encoding, not a truncated hash or a display-name slug. */
export const OPENVIKING_MAPPER_VERSION = 1 as const;
export const OPENVIKING_UPSTREAM_PIN = "92285e5b373ef927021544597b65e56bc9d0d5c8";
export interface OpenVikingBotIdentity {
  readonly mapperVersion: 1;
  readonly workspaceId: string;
  readonly botId: string;
  readonly accountId: string;
  readonly userId: string;
}
const minted = new WeakSet<object>();

export function encodeOpenVikingHostId(value: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("OpenViking invalid host id");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 128 || bytes.toString("utf8") !== value) throw new Error("OpenViking invalid host id");
  return bytes.toString("hex");
}

/** Only host code resolves immutable IDs. Persist this descriptor in the host ledger; labels never participate. */
export class OpenVikingIdentityMapper {
  readonly accountId: string;
  constructor(readonly workspaceId: string) {
    this.accountId = `dx1_${encodeOpenVikingHostId(workspaceId)}`;
    Object.freeze(this);
  }
  bot(botId: string): OpenVikingBotIdentity {
    const identity: OpenVikingBotIdentity = Object.freeze({ mapperVersion: 1, workspaceId: this.workspaceId, botId,
      accountId: this.accountId, userId: `bot1_${encodeOpenVikingHostId(botId)}` });
    minted.add(identity);
    return identity;
  }
}

/** JSON from an engine/UI cannot mint an identity. This brand is a wiring guard, not an OS sandbox. */
export function assertOpenVikingBotIdentity(identity: OpenVikingBotIdentity): void {
  if (!identity || !minted.has(identity)) throw new Error("OpenViking untrusted identity");
}

export function canonicalOpenVikingUri(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("viking://")) throw new Error("OpenViking invalid uri");
  const parts = value.slice(9).split("/");
  if (parts.length < 2 || !parts.every((part, i) => /^[A-Za-z0-9_-]+$/.test(part) ||
    (i === parts.length - 1 && /^[A-Za-z0-9_-]+\.md$/.test(part)))) throw new Error("OpenViking invalid uri");
  return value; // No decoding, path variables, aliases, traversal, query, fragment, or silent normalization.
}

export function openVikingPrivateMemoryRoot(identity: OpenVikingBotIdentity): string {
  assertOpenVikingBotIdentity(identity);
  // Curated bytes use private resources. Native memories can normalize fields and are a separate future contract.
  return `viking://user/${identity.userId}/resources/dexter/memory`;
}

export interface OpenVikingRevisionRef { recordId: string; revision: number; sha256: string }
export function openVikingRevisionUri(identity: OpenVikingBotIdentity, ref: OpenVikingRevisionRef): string {
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1 || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error("OpenViking invalid revision");
  return `${openVikingPrivateMemoryRoot(identity)}/rec1_${encodeOpenVikingHostId(ref.recordId)}/v${ref.revision}-${ref.sha256}.md`;
}

export function parseOpenVikingRevisionUri(identity: OpenVikingBotIdentity, uri: string): OpenVikingRevisionRef {
  canonicalOpenVikingUri(uri);
  const root = `${openVikingPrivateMemoryRoot(identity)}/`;
  if (!uri.startsWith(root)) throw new Error("OpenViking uri outside identity");
  const match = /^rec1_([a-f0-9]+)\/v([1-9][0-9]*)-([a-f0-9]{64})\.md$/.exec(uri.slice(root.length));
  if (!match) throw new Error("OpenViking invalid revision uri");
  const ref = { recordId: Buffer.from(match[1]!, "hex").toString("utf8"), revision: Number(match[2]), sha256: match[3]! };
  if (openVikingRevisionUri(identity, ref) !== uri) throw new Error("OpenViking noncanonical revision uri");
  return ref;
}

/** Pin 92285e5 uses three unpadded base64url UTF-8 segments, including the generated 64-hex secret. */
export function validateOpenVikingUserKey(key: unknown, identity: OpenVikingBotIdentity): asserts key is string {
  assertOpenVikingBotIdentity(identity);
  if (typeof key !== "string" || key.length > 2048) throw new Error("OpenViking invalid credential");
  const parts = key.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part) && Buffer.from(part, "base64url").toString("base64url") === part)) throw new Error("OpenViking invalid credential");
  const decoded = parts.map(part => Buffer.from(part, "base64url").toString("utf8"));
  if (decoded[0] !== identity.accountId || decoded[1] !== identity.userId || !/^[a-f0-9]{64}$/.test(decoded[2]!)) throw new Error("OpenViking invalid credential");
}
