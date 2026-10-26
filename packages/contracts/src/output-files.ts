import { z } from "zod";

/**
 * Output folders of one base (host): a general folder owned by the owner, with one namespace per bot (`Bots/<botId>`)
 * and per team (`Times/<teamId>`). Owner-loopback contract between the Apple app and the host.
 *
 * - The general folder is the owner's inventory, never a read grant for bots. A bot's file tools reach only the
 *   namespace derived from its turn (its own bot namespace, or its team's namespace in a team turn); group turns have no
 *   file tools.
 * - Every base has its own location ledger. Changing the destination affects only NEW files: nothing is moved or deleted,
 *   older generations stay listable/exportable.
 * - Engine-native working directories, Context artifacts/documents/memory and terminal homes are different custody and
 *   are not part of the output folders.
 * - Names shown to the owner (bot/team names) are display data; identity is the stable id.
 * - Remote browsing (another device) exists only over the direct paired mTLS channel, with the exact owner-granted
 *   `outputs.read` / `outputs.manage` scope; the encrypted relay never carries these routes.
 */
export const OUTPUT_FILES_CONTRACT_VERSION = 1 as const;
export const OUTPUT_FILES_LIMITS = Object.freeze({
  pageEntries: 200, scannedEntries: 10_000, namespaces: 1_000, ledgerGenerations: 256, relativePathCharacters: 1024, rootPathCharacters: 1024,
  chunkBytes: 8 * 1024 * 1024, exportBytes: 2 * 1024 * 1024 * 1024, hashedBytes: 256 * 1024 * 1024,
  /** Largest content chunk over the paired channel (its response cap); the owner loopback keeps `chunkBytes`. */
  pairedChunkBytes: 256 * 1024,
});
/**
 * Who may browse this base's outputs. `owner_loopback_only`: this host composes no paired app-client channel (and every
 * host before the value evolved). `owner_loopback_and_paired_scoped`: also paired app clients over the direct mTLS channel,
 * each request gated by the exact `outputs.read` / `outputs.manage` scope the owner granted in the pairing offer (never by
 * default). It states the composed policy, not that a client is paired or the listener is up. Closed: unknown values fail.
 */
export const OUTPUT_REMOTE_BROWSING = Object.freeze(["owner_loopback_only", "owner_loopback_and_paired_scoped"] as const);
export type OutputRemoteBrowsing = typeof OUTPUT_REMOTE_BROWSING[number];

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Bot and team ids used as folder names (same pattern as the hub/Context identities). */
const NAMESPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const Text = (max: number) => z.string().min(1).max(max).refine(wellFormed, "Text must be well-formed without control characters.");
const RequestId = z.string().regex(ID);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Generation = z.number().int().min(1).max(OUTPUT_FILES_LIMITS.ledgerGenerations);
const HostId = z.string().min(1).max(128);
/** Absolute host path, display/reveal only. On a remote base it is never a local Finder path. */
export const OutputHostPathSchema = Text(OUTPUT_FILES_LIMITS.rootPathCharacters).refine(value => value.startsWith("/") && !value.includes("\\"), "Absolute host path required.");
/** Path relative to a namespace: `/`-separated, no empty, `.` or `..` segment, no backslash. `.` is the namespace itself. */
export const OutputRelativePathSchema = Text(OUTPUT_FILES_LIMITS.relativePathCharacters).refine(value => value === "."
  || (!value.startsWith("/") && !value.includes("\\") && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..")), "Relative path required.");

/**
 * `host_data_legacy`: implicit generation 1 of every base (nothing changes until the owner chooses): the host data
 * directory, bots in `bot-files/<botId>`, teams in `team-files/<teamId>`, no general listing (it holds internal stores).
 * `host_data_default`: `<dataDir>/outputs`. `owner_path`: a real folder chosen by the owner on the host's own disk.
 */
export const OutputLocationKindSchema = z.enum(["host_data_legacy", "host_data_default", "owner_path"]);
export type OutputLocationKind = z.infer<typeof OutputLocationKindSchema>;
/** `v1`: general root with `Bots/<botId>` and `Times/<teamId>`. `legacy`: see `host_data_legacy`. */
export const OutputLayoutSchema = z.enum(["v1", "legacy"]);
/** Closed availability of a location's root, checked live (never inferred from configuration). */
export const OutputLocationAvailabilitySchema = z.enum(["available", "not_created", "missing", "replaced", "unsafe", "unreadable"]);
export const OutputLocationSchema = z.strictObject({
  generation: Generation,
  kind: OutputLocationKindSchema,
  layout: OutputLayoutSchema,
  path: OutputHostPathSchema,
  current: z.boolean(),
  availability: OutputLocationAvailabilitySchema,
  namespaces: z.strictObject({ general: z.boolean(), bots: z.boolean(), teams: z.boolean() }),
  /** null only for the not yet persisted first generation. */
  createdAt: Timestamp.nullable(),
  retiredAt: Timestamp.nullable(),
});
export type OutputLocation = z.infer<typeof OutputLocationSchema>;

export const OutputFilesStatusSchema = z.strictObject({
  version: z.literal(OUTPUT_FILES_CONTRACT_VERSION),
  hostId: HostId,
  revision: Revision,
  /** false until the first destination change or namespace creation persists the ledger (`output-files.sqlite`). */
  persisted: z.boolean(),
  current: OutputLocationSchema,
  host: z.strictObject({ platform: z.enum(["darwin", "linux", "other"]) }),
  /** Fixed facts of this build, so no client infers more than exists. */
  scope: z.strictObject({
    botFileTools: z.literal("own_bot_namespace"),
    teamFileTools: z.literal("team_namespace_revalidated"),
    groupTurns: z.literal("no_file_tools"),
    terminalCwd: z.literal("output_namespace_not_os_sandbox"),
    engineNativeWorkspace: z.literal("internal_not_outputs"),
    contextDocuments: z.literal("separate_custody"),
    sharing: z.literal("not_implemented"),
    remoteBrowsing: z.enum(OUTPUT_REMOTE_BROWSING),
    /** Additive (absent on older hosts): output routes are never carried by the encrypted relay. */
    relayedBrowsing: z.literal("not_relayed").optional(),
  }),
  limits: z.strictObject({ pageEntries: z.number().int(), scannedEntries: z.number().int(), chunkBytes: z.number().int(), exportBytes: z.number().int(),
    hashedBytes: z.number().int(), toolFileBytes: z.number().int(),
    /** Additive (absent on older hosts): paired-channel chunk cap when `remoteBrowsing` includes paired clients, else null. */
    pairedChunkBytes: z.number().int().min(1).max(OUTPUT_FILES_LIMITS.pairedChunkBytes).nullable().optional() }),
}).refine(value => value.limits.pairedChunkBytes === undefined
  || (value.scope.remoteBrowsing === "owner_loopback_and_paired_scoped") === (value.limits.pairedChunkBytes !== null),
  "Paired chunk limit must match remote browsing.");
export type OutputFilesStatus = z.infer<typeof OutputFilesStatusSchema>;

export const OutputLocationsSchema = z.strictObject({
  version: z.literal(OUTPUT_FILES_CONTRACT_VERSION), hostId: HostId, revision: Revision,
  items: z.array(OutputLocationSchema).min(1).max(OUTPUT_FILES_LIMITS.ledgerGenerations),
});
export type OutputLocations = z.infer<typeof OutputLocationsSchema>;

/** `general` | `bot:<botId>` | `team:<teamId>`. */
export const OutputNamespaceRefSchema = z.string().max(133).refine(value => value === "general"
  || (/^(bot|team):/.test(value) && NAMESPACE_ID.test(value.slice(value.indexOf(":") + 1))), "Namespace reference required.");
export const OutputNamespaceSchema = z.strictObject({
  ref: OutputNamespaceRefSchema,
  kind: z.enum(["general", "bot", "team"]),
  id: z.string().regex(NAMESPACE_ID).nullable(),
  /** Current display name (bot/team), null when the bot/team no longer exists. Never identity. */
  label: Text(120).nullable(),
  /** `orphan`: a folder whose bot/team was deleted; kept so older outputs never vanish. */
  status: z.enum(["active", "orphan"]),
  exists: z.boolean(),
  /** Relative to the location root ("" for general). */
  relativePath: z.string().max(140),
});
export type OutputNamespace = z.infer<typeof OutputNamespaceSchema>;
export const OutputNamespacesSchema = z.strictObject({
  version: z.literal(OUTPUT_FILES_CONTRACT_VERSION), hostId: HostId, generation: Generation,
  items: z.array(OutputNamespaceSchema).max(OUTPUT_FILES_LIMITS.namespaces + 1), truncated: z.boolean(),
});
export type OutputNamespaces = z.infer<typeof OutputNamespacesSchema>;

export const OutputEntrySchema = z.strictObject({
  name: Text(255), path: OutputRelativePathSchema,
  /** `blocked`: symlink, hardlink, device/socket/fifo — listed by name only, never opened or exported. */
  type: z.enum(["file", "directory", "blocked"]),
  bytes: z.number().int().min(0).nullable(),
  modifiedAt: Timestamp.nullable(),
  mediaType: z.string().max(100).nullable(),
});
export type OutputEntry = z.infer<typeof OutputEntrySchema>;
export const OutputEntriesSchema = z.strictObject({
  version: z.literal(OUTPUT_FILES_CONTRACT_VERSION), hostId: HostId, generation: Generation, namespace: OutputNamespaceRefSchema,
  path: OutputRelativePathSchema, exists: z.boolean(),
  items: z.array(OutputEntrySchema).max(OUTPUT_FILES_LIMITS.pageEntries),
  /** Name of the last item; pass as `after` for the next page. */
  nextCursor: Text(255).nullable(),
  /** Entries never shown: secret-like names and Dexter temporary files (counts only). */
  hidden: z.strictObject({ secretLike: z.number().int().min(0), internal: z.number().int().min(0) }),
  truncated: z.boolean(),
});
export type OutputEntries = z.infer<typeof OutputEntriesSchema>;

export const OutputItemSchema = z.strictObject({
  version: z.literal(OUTPUT_FILES_CONTRACT_VERSION), hostId: HostId, generation: Generation, namespace: OutputNamespaceRefSchema,
  path: OutputRelativePathSchema, name: Text(255), bytes: z.number().int().min(0), modifiedAt: Timestamp, mediaType: z.string().max(100),
  /** Identity pin (device, inode, size, mtime, ctime); every content chunk must present it. */
  pin: Hash,
  /** SHA-256 of the content, or null above `hashedBytes`. */
  sha256: Hash.nullable(),
  exportable: z.boolean(),
});
export type OutputItem = z.infer<typeof OutputItemSchema>;

export const OutputDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host_data_default") }),
  z.strictObject({ kind: z.literal("owner_path"), path: OutputHostPathSchema }),
]);
export type OutputDestination = z.infer<typeof OutputDestinationSchema>;
export const SetOutputDestinationSchema = z.strictObject({
  expectedHostID: HostId, clientRequestId: RequestId, expectedRevision: Revision.max(Number.MAX_SAFE_INTEGER - 1), destination: OutputDestinationSchema,
});
export type SetOutputDestination = z.infer<typeof SetOutputDestinationSchema>;
export const OutputDestinationReceiptSchema = z.strictObject({
  version: z.literal(OUTPUT_FILES_CONTRACT_VERSION), hostId: HostId, clientRequestId: RequestId, requestHash: Hash,
  previousRevision: Revision, revision: Revision, previousGeneration: Generation, generation: Generation,
  destination: z.strictObject({ kind: z.enum(["host_data_default", "owner_path"]), path: OutputHostPathSchema }),
  /** Always false: a destination change never moves or deletes existing outputs. */
  existingFilesMoved: z.literal(false),
  createdAt: Timestamp,
});
export type OutputDestinationReceipt = z.infer<typeof OutputDestinationReceiptSchema>;
