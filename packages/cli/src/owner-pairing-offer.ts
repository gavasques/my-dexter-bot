import { createHash } from "node:crypto";
import {
  CancelOwnerPairingOfferSchema, CreateOwnerPairingOfferSchema, OwnerPairingOfferIdSchema, OwnerPairingReceiptSchema, OwnerPairingRequestIdSchema,
  OWNER_PAIRING_HISTORICAL_SCOPES, OWNER_PAIRING_OFFER_CONTRACT_VERSION, OWNER_PAIRING_OFFER_LIMITS, OWNER_PAIRING_OPT_IN_SCOPES,
  type OwnerPairingInvitationRead, type OwnerPairingOfferResult, type OwnerPairingReceipt, type OwnerPairingRecord, type OwnerPairingRole,
  type OwnerPairingScope, type OwnerPairingStatus, type OwnerPairingUnavailableReason,
} from "@dexter/contracts";
import { HostError } from "@dexter/hub";
import { OwnerPairingJournal, OWNER_PAIRING_JOURNAL_SCHEMA_VERSION, OWNER_PAIRING_OFFERS_DATABASE_FILE, type OwnerPairingJournalRow } from "./owner-pairing-journal.js";

/**
 * Owner pairing offers of this base (contracts/owner-pairing-offer.ts): the human owner creates and cancels one-time app
 * client invitations from the app, through the SAME running app-client channel (its operator-supplied TLS identity,
 * listener and ClientPairingRegistry). Nothing here generates a certificate, key or Keychain item.
 *
 * Journal: the dedicated owner pairing journal (`owner-pairing-journal.ts`, shared with claim decisions; offers keep
 * their own revision). One row per client request: reserved (revision bumped) BEFORE the registry effect, then
 * finalized with the receipt. A reserved row that never finalized reads as `unknown`; a code is
 * never re-issued for it. Receipts never contain the one-time code, only the SHA-256 pin of the invitation text.
 *
 * Invitation text: retained ONLY in this process's memory, for at most `invitationDeliveries` deliveries (the POST
 * response is the first), until the offer expires, is claimed, exhausted or cancelled, or the host stops.
 */
export { OWNER_PAIRING_OFFERS_DATABASE_FILE };
export const OWNER_PAIRING_OFFERS_SCHEMA_VERSION = OWNER_PAIRING_JOURNAL_SCHEMA_VERSION;
const APP_CLIENT_PROTOCOL = "dexter-app-client-v1";
const CODE = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_RETAINED_INVITATIONS = 32;
type Row = OwnerPairingJournalRow;
type OfferStatus = "open" | "claimed" | "cancelled" | "exhausted" | "expired";

/** Exact public fields of the app-client pairing bundle (`AppClientPairingBundle`); `code` is the one-time secret. */
export interface OwnerPairingBundleSource {
  protocol: string; installationId: string; hostUrl: string; hostCertificateDER: string; hostFingerprint: string;
  offerId: string; kind: "pair" | "rotate"; role: string; scopes: readonly string[]; deviceId: string | null; expiresAt: number; code: string;
}
/** Structurally the AppClientServices admin facade (pair offers only; rotation never goes through this flow). */
export interface OwnerPairingAdminPort {
  pairingBundle(input: { kind: "pair"; role: OwnerPairingRole; scopes: readonly OwnerPairingScope[] }, ttlMs: number): OwnerPairingBundleSource;
  offerState(offerId: string): { status: OfferStatus; expiresAt: number } | null;
  cancelOffer(offerId: string): void;
}
/** Structurally AppClientServices.pairingChannel(). */
export interface OwnerPairingChannelFacts {
  listening: boolean; installationId: string; hostUrl: string | null; hostFingerprint: string;
  certificateNotBefore: number; certificateNotAfter: number; offerTtlMs: number;
}
export interface OwnerPairingOffersOptions {
  dataDir: string;
  identity: () => { hostId: string; ownerId: string };
  now: () => number;
  /** Canonical writer fence (HostStore.withWriterLease) around every journal mutation. */
  writer: <T>(operation: () => T) => T;
  /** Null: no app-client channel on this host. Throws once the host stopped admission. */
  channel: () => OwnerPairingChannelFacts | null;
  admin: () => Readonly<OwnerPairingAdminPort>;
  closing: () => boolean;
  /** Shared journal (HostServices passes the one claim decisions also use); a private one is opened otherwise. */
  journal?: OwnerPairingJournal;
}
interface Retained { text: string; sha256: string; offerId: string; expiresAt: number; remaining: number }

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
const unavailable = (message: string): never => { throw new HostError("device_unavailable", message); };
const unknownOutcome = (): never => { throw new HostError("outcome_unknown", "Pairing offer outcome is unconfirmed."); };

export class OwnerPairingOffers {
  readonly #options: OwnerPairingOffersOptions;
  readonly #retained = new Map<string, Retained>();
  /** Request ids whose invitation was delivered the maximum number of times (bounded like the retained map). */
  readonly #spent = new Set<string>();
  readonly #journal: OwnerPairingJournal;
  readonly #ownsJournal: boolean;
  #closed = false;

  /** Pure construction: no file is opened or created until the first status read of an existing journal or decision. */
  constructor(options: OwnerPairingOffersOptions) {
    this.#options = options;
    this.#ownsJournal = options.journal === undefined;
    this.#journal = options.journal ?? new OwnerPairingJournal({ dataDir: options.dataDir, identity: options.identity, now: options.now, writer: options.writer });
  }

  close(): void {
    this.#closed = true;
    this.#retained.clear(); this.#spent.clear();
    if (this.#ownsJournal) this.#journal.close();
  }

  // ---- journal ------------------------------------------------------------------------------------

  #revision(): number { this.#admitted(); return this.#journal.revision("offers"); }
  #row(clientRequestId: string): Row | null { this.#admitted(); return this.#journal.row(clientRequestId); }
  #one(sql: string, ...params: (string | number | null)[]): Row | null { this.#admitted(); return this.#journal.one(sql, ...params); }
  #admitted(): void { if (this.#closed || this.#journal.closed) unavailable("Pairing offers are not available."); }
  /** Reserve BEFORE the effect: dedupe row + revision bump, durable under the writer fence. */
  #reserve(input: { clientRequestId: string; operation: "create" | "cancel"; requestHash: string; expectedRevision: number; offerId: string | null }): number {
    this.#admitted();
    return this.#journal.reserve(input);
  }
  #finalize(clientRequestId: string, receipt: OwnerPairingReceipt): void {
    this.#admitted();
    this.#journal.finalize(clientRequestId, JSON.stringify(receipt), receipt.offer?.offerId ?? null);
  }
  /** Stored receipt, or the honest `unknown` receipt of a reservation that never finalized. */
  #receipt(row: Row): OwnerPairingReceipt {
    if (row.state === "done") {
      let parsed: unknown;
      try { parsed = JSON.parse(String(row.receipt)); } catch { throw new HostError("conflict", "Pairing offer journal is inconsistent."); }
      const receipt = OwnerPairingReceiptSchema.safeParse(parsed);
      if (!receipt.success || receipt.data.clientRequestId !== row.client_request_id || receipt.data.requestHash !== row.request_hash
        || receipt.data.hostId !== this.#options.identity().hostId) throw new HostError("conflict", "Pairing offer journal is inconsistent.");
      return receipt.data;
    }
    const offerId = row.offer_id === null ? null : String(row.offer_id);
    return { version: OWNER_PAIRING_OFFER_CONTRACT_VERSION, hostId: this.#options.identity().hostId, clientRequestId: String(row.client_request_id),
      requestHash: String(row.request_hash), operation: row.operation === "cancel" ? "cancel" : "create", previousRevision: Number(row.previous_revision),
      revision: Number(row.revision), outcome: "unknown", offer: offerId ? this.#createdOffer(offerId)?.offer ?? null : null, invitationSha256: null,
      grantsCreated: 0, createdAt: Number(row.created_at) };
  }
  #createdOffer(offerId: string): OwnerPairingReceipt | null {
    const row = this.#one("SELECT * FROM requests WHERE operation = 'create' AND state = 'done' AND offer_id = ?", offerId);
    if (!row) return null;
    const receipt = this.#receipt(row);
    return receipt.outcome === "created" && receipt.offer?.offerId === offerId ? receipt : null;
  }

  // ---- live facts ---------------------------------------------------------------------------------

  #offerState(offerId: string): OfferStatus | null {
    try { return this.#options.admin().offerState(offerId)?.status ?? null; } catch { return null; }
  }
  #purge(): void {
    const now = this.#options.now();
    for (const [id, entry] of this.#retained) if (entry.expiresAt <= now) this.#retained.delete(id);
    while (this.#retained.size > MAX_RETAINED_INVITATIONS) this.#retained.delete(this.#retained.keys().next().value!);
    while (this.#spent.size > MAX_RETAINED_INVITATIONS * 4) this.#spent.delete(this.#spent.values().next().value!);
  }
  #live(receipt: OwnerPairingReceipt): OwnerPairingRecord["live"] {
    this.#purge();
    const state = receipt.offer ? this.#offerState(receipt.offer.offerId) : null;
    if (state !== "open") for (const [id, entry] of this.#retained) if (entry.offerId === receipt.offer?.offerId) this.#retained.delete(id);
    const retained = receipt.operation === "create" && receipt.outcome === "created" && state === "open" && this.#retained.has(receipt.clientRequestId);
    return { offerState: state ?? "unknown", invitation: retained ? "retained" : "not_retained" };
  }
  /** One finite delivery of a retained invitation pinned to the receipt; null when it cannot be delivered. */
  #deliver(receipt: OwnerPairingReceipt): { text: string; sha256: string; deliveriesRemaining: number } | null {
    const entry = this.#retained.get(receipt.clientRequestId);
    if (!entry || entry.sha256 !== receipt.invitationSha256 || entry.offerId !== receipt.offer?.offerId) return null;
    entry.remaining -= 1;
    if (entry.remaining <= 0) { this.#retained.delete(receipt.clientRequestId); this.#spent.add(receipt.clientRequestId); }
    return { text: entry.text, sha256: entry.sha256, deliveriesRemaining: Math.max(0, entry.remaining) };
  }

  // ---- owner operations ---------------------------------------------------------------------------

  #channel(): { facts: OwnerPairingChannelFacts | null; reason: OwnerPairingUnavailableReason | null } {
    if (this.#closed || this.#options.closing()) return { facts: null, reason: "host_closing" };
    let facts: OwnerPairingChannelFacts | null;
    try { facts = this.#options.channel(); } catch { return { facts: null, reason: "host_closing" }; }
    if (!facts) return { facts: null, reason: "app_client_channel_unconfigured" };
    const now = this.#options.now();
    if (facts.installationId !== this.#options.identity().hostId) return { facts, reason: "app_client_channel_unconfigured" };
    if (!facts.listening || facts.hostUrl === null) return { facts, reason: "app_client_listener_not_listening" };
    if (!FINGERPRINT.test(facts.hostFingerprint) || !(facts.certificateNotBefore <= now && now < facts.certificateNotAfter)) return { facts, reason: "app_client_certificate_not_valid" };
    if (Math.floor(facts.offerTtlMs / 1_000) < OWNER_PAIRING_OFFER_LIMITS.minTtlSeconds) return { facts, reason: "app_client_offer_ttl_too_short" };
    return { facts, reason: null };
  }
  status(): OwnerPairingStatus {
    const { hostId } = this.#options.identity(), { facts, reason } = this.#channel();
    const maxSeconds = facts ? Math.min(OWNER_PAIRING_OFFER_LIMITS.maxTtlSeconds, Math.floor(facts.offerTtlMs / 1_000)) : 0;
    return {
      version: OWNER_PAIRING_OFFER_CONTRACT_VERSION, hostId, revision: this.#closed || this.#journal.closed ? 1 : this.#revision(),
      // Issued only while offers can be created; it materializes the journal identity (no request, no offer).
      journalPin: reason === null ? this.#journal.pin() : null,
      availability: reason === null ? "available" : "unavailable", reason,
      channel: facts ? { status: facts.listening && facts.hostUrl !== null ? "listening" : "not_listening", installationId: facts.installationId,
        hostUrl: facts.hostUrl, hostFingerprint: FINGERPRINT.test(facts.hostFingerprint) ? facts.hostFingerprint : null, certificateNotAfter: facts.certificateNotAfter }
        : { status: "unconfigured", installationId: null, hostUrl: null, hostFingerprint: null, certificateNotAfter: null },
      ttl: facts && maxSeconds >= 1 ? { minSeconds: Math.min(OWNER_PAIRING_OFFER_LIMITS.minTtlSeconds, maxSeconds), maxSeconds, defaultSeconds: maxSeconds } : null,
      roles: ["client-ios", "client-mac"],
      scopes: { historical: [...OWNER_PAIRING_HISTORICAL_SCOPES], optIn: [...OWNER_PAIRING_OPT_IN_SCOPES] },
      limits: { invitationDeliveries: OWNER_PAIRING_OFFER_LIMITS.invitationDeliveries, invitationBytes: OWNER_PAIRING_OFFER_LIMITS.invitationBytes },
    };
  }
  record(clientRequestId: string): OwnerPairingRecord | null {
    if (this.#closed) unavailable("Pairing offers are not available.");
    const row = this.#row(OwnerPairingRequestIdSchema.parse(clientRequestId));
    // Claim decisions share the journal but have their own receipts (owner-pairing-claims.ts).
    if (!row || (row.operation !== "create" && row.operation !== "cancel")) return null;
    const receipt = this.#receipt(row);
    return { receipt, live: this.#live(receipt) };
  }
  invitation(clientRequestId: string, requestHash: string): OwnerPairingInvitationRead {
    if (this.#closed) unavailable("Pairing offers are not available.");
    const row = this.#row(OwnerPairingRequestIdSchema.parse(clientRequestId));
    if (!row) throw new HostError("not_found", "Pairing offer receipt absent; outcome remains unconfirmed.");
    if (row.operation !== "create") throw new HostError("invalid_input", "Only created offers have an invitation.");
    if (typeof requestHash !== "string" || row.request_hash !== requestHash) throw new HostError("conflict", "The invitation is pinned to another request.");
    const receipt = this.#receipt(row), base = { version: OWNER_PAIRING_OFFER_CONTRACT_VERSION, hostId: receipt.hostId, clientRequestId: receipt.clientRequestId } as const;
    const unavailableRead = (reason: Extract<OwnerPairingInvitationRead, { availability: "unavailable" }>["reason"]): OwnerPairingInvitationRead =>
      ({ ...base, offerId: receipt.offer?.offerId ?? null, availability: "unavailable", reason });
    if (receipt.outcome !== "created" || !receipt.offer) return unavailableRead("outcome_unknown");
    const state = this.#live(receipt).offerState;
    if (state !== "open") return unavailableRead(state === "unknown" ? "not_retained" : state);
    const delivered = this.#deliver(receipt);
    if (!delivered) return unavailableRead(this.#spent.has(receipt.clientRequestId) ? "delivery_limit" : "not_retained");
    return { ...base, offerId: receipt.offer.offerId, availability: "available", invitation: delivered };
  }

  /** Exact replay returns the original receipt (and a retained invitation); another body under the same id conflicts. */
  create(raw: unknown): { created: boolean; result: OwnerPairingOfferResult } {
    if (this.#closed || this.#options.closing()) unavailable("Pairing offers are not available while the host stops.");
    const input = CreateOwnerPairingOfferSchema.parse(raw);
    const { hostId } = this.#options.identity();
    if (input.expectedHostId !== hostId) throw new HostError("conflict", "Host identity changed.");
    const requestHash = sha256(canonical({ clientRequestId: input.clientRequestId, expectedHostId: input.expectedHostId, expectedJournalPin: input.expectedJournalPin,
      expectedRevision: input.expectedRevision, role: input.role, scopes: input.scopes, ttlSeconds: input.ttlSeconds }));
    const prior = this.#row(input.clientRequestId);
    if (prior) {
      if (prior.operation !== "create" || prior.request_hash !== requestHash) throw new HostError("conflict", "Client request id was already used for another request.");
      const receipt = this.#receipt(prior), live = this.#live(receipt);
      const invitation = live.invitation === "retained" ? this.#deliver(receipt) : null;
      return { created: false, result: { record: { receipt, live: invitation ? live : { ...live, invitation: "not_retained" } }, invitation } };
    }
    const { facts, reason } = this.#channel();
    if (reason !== null || !facts || facts.hostUrl === null) return unavailable("Pairing offers are unavailable on this host.");
    // No receipt here: a request formed under another journal continuity (restore, lost journal) is refused, never new.
    this.#journal.assertPin(input.expectedJournalPin);
    if (this.#revision() !== input.expectedRevision) throw new HostError("conflict", "Pairing offer revision changed.");
    if (input.ttlSeconds * 1_000 > facts.offerTtlMs) throw new HostError("invalid_input", "Offer lifetime exceeds this host's limit.");
    const admin = this.#options.admin();
    const createdAt = this.#reserve({ clientRequestId: input.clientRequestId, operation: "create", requestHash, expectedRevision: input.expectedRevision, offerId: null });
    const unknown = (offerId: string | null): never => {
      // Never delivered: the offer (if any) is unusable; cancel it best-effort and record the honest outcome.
      if (offerId) { try { admin.cancelOffer(offerId); } catch { /* expires by itself */ } }
      try { this.#finalize(input.clientRequestId, { version: OWNER_PAIRING_OFFER_CONTRACT_VERSION, hostId, clientRequestId: input.clientRequestId, requestHash, operation: "create",
        previousRevision: input.expectedRevision, revision: input.expectedRevision + 1, outcome: "unknown", offer: null, invitationSha256: null, grantsCreated: 0, createdAt }); }
      catch { /* stays reserved: reads as unknown */ }
      return unknownOutcome();
    };
    let bundle: OwnerPairingBundleSource;
    try { bundle = admin.pairingBundle({ kind: "pair", role: input.role, scopes: input.scopes }, input.ttlSeconds * 1_000); }
    catch { return unknown(null); }
    const offerId = OwnerPairingOfferIdSchema.safeParse(bundle.offerId).success ? bundle.offerId : null;
    if (!offerId || bundle.protocol !== APP_CLIENT_PROTOCOL || bundle.kind !== "pair" || bundle.deviceId !== null || bundle.role !== input.role
      || JSON.stringify([...bundle.scopes]) !== JSON.stringify(input.scopes) || bundle.installationId !== hostId || bundle.hostUrl !== facts.hostUrl
      || bundle.hostFingerprint !== facts.hostFingerprint || !Number.isSafeInteger(bundle.expiresAt) || bundle.expiresAt <= createdAt
      || bundle.expiresAt > createdAt + input.ttlSeconds * 1_000 + 60_000 || typeof bundle.code !== "string" || !CODE.test(bundle.code)
      || typeof bundle.hostCertificateDER !== "string" || bundle.hostCertificateDER.length > 4_096) return unknown(offerId);
    // Exactly the `dexter app-client offer` bundle, in its key order: what the other device's importer accepts.
    const text = JSON.stringify({ protocol: bundle.protocol, installationId: bundle.installationId, hostUrl: bundle.hostUrl, hostCertificateDER: bundle.hostCertificateDER,
      hostFingerprint: bundle.hostFingerprint, offerId, kind: "pair", role: bundle.role, scopes: [...bundle.scopes], deviceId: null, expiresAt: bundle.expiresAt,
      code: bundle.code }) + "\n";
    if (Buffer.byteLength(text, "utf8") > OWNER_PAIRING_OFFER_LIMITS.invitationBytes) return unknown(offerId);
    const receipt: OwnerPairingReceipt = { version: OWNER_PAIRING_OFFER_CONTRACT_VERSION, hostId, clientRequestId: input.clientRequestId, requestHash, operation: "create",
      previousRevision: input.expectedRevision, revision: input.expectedRevision + 1, outcome: "created",
      offer: { offerId, kind: "pair", role: input.role, scopes: [...input.scopes], expiresAt: bundle.expiresAt, installationId: hostId, hostUrl: bundle.hostUrl,
        hostFingerprint: bundle.hostFingerprint }, invitationSha256: sha256(text), grantsCreated: 0, createdAt };
    try { this.#finalize(input.clientRequestId, receipt); } catch { return unknown(offerId); }
    this.#retained.set(input.clientRequestId, { text, sha256: receipt.invitationSha256!, offerId, expiresAt: bundle.expiresAt,
      remaining: OWNER_PAIRING_OFFER_LIMITS.invitationDeliveries });
    this.#purge();
    const invitation = this.#deliver(receipt);
    return { created: true, result: { record: { receipt, live: { offerState: "open", invitation: invitation && invitation.deliveriesRemaining > 0 ? "retained" : "not_retained" } }, invitation } };
  }

  /** Cancels an OPEN offer created through this flow; anything else is refused with no effect and no revision change. */
  cancel(offerIdRaw: string, raw: unknown): { created: boolean; result: OwnerPairingRecord } {
    if (this.#closed || this.#options.closing()) unavailable("Pairing offers are not available while the host stops.");
    const offerId = OwnerPairingOfferIdSchema.parse(offerIdRaw), input = CancelOwnerPairingOfferSchema.parse(raw);
    const { hostId } = this.#options.identity();
    if (input.expectedHostId !== hostId) throw new HostError("conflict", "Host identity changed.");
    const requestHash = sha256(canonical({ clientRequestId: input.clientRequestId, expectedHostId: input.expectedHostId, expectedJournalPin: input.expectedJournalPin,
      expectedRevision: input.expectedRevision, offerId }));
    const prior = this.#row(input.clientRequestId);
    if (prior) {
      if (prior.operation !== "cancel" || prior.request_hash !== requestHash) throw new HostError("conflict", "Client request id was already used for another request.");
      const receipt = this.#receipt(prior);
      return { created: false, result: { receipt, live: this.#live(receipt) } };
    }
    const { facts, reason } = this.#channel();
    // Cancelling needs the registry only (not the listener or a valid certificate), but never another channel.
    if (!facts || reason === "host_closing" || reason === "app_client_channel_unconfigured") return unavailable("Pairing offers are unavailable on this host.");
    this.#journal.assertPin(input.expectedJournalPin);
    if (this.#revision() !== input.expectedRevision) throw new HostError("conflict", "Pairing offer revision changed.");
    const created = this.#createdOffer(offerId);
    if (!created?.offer) throw new HostError("not_found", "Offer was not created through the owner pairing flow.");
    const admin = this.#options.admin(), state = admin.offerState(offerId);
    if (state?.status !== "open") throw new HostError("conflict", "Offer is no longer open.");
    const createdAt = this.#reserve({ clientRequestId: input.clientRequestId, operation: "cancel", requestHash, expectedRevision: input.expectedRevision, offerId });
    for (const [id, entry] of this.#retained) if (entry.offerId === offerId) this.#retained.delete(id);
    const receipt: OwnerPairingReceipt = { version: OWNER_PAIRING_OFFER_CONTRACT_VERSION, hostId, clientRequestId: input.clientRequestId, requestHash, operation: "cancel",
      previousRevision: input.expectedRevision, revision: input.expectedRevision + 1, outcome: "cancelled", offer: created.offer, invitationSha256: null, grantsCreated: 0, createdAt };
    try { admin.cancelOffer(offerId); }
    catch {
      try { this.#finalize(input.clientRequestId, { ...receipt, outcome: "unknown" }); } catch { /* reads as unknown */ }
      return unknownOutcome();
    }
    try { this.#finalize(input.clientRequestId, receipt); } catch { return unknownOutcome(); }
    return { created: true, result: { receipt, live: this.#live(receipt) } };
  }
}
