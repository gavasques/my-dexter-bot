#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import Observation

/// Focused owner controller (no UI) for "Convidar outro aparelho" on THIS Mac's base: reads the real channel status,
/// drafts the offer from the owner's explicit choices (device kind, `PairingScopeSelection`, lifetime), creates it once
/// and keeps its invitation text in memory only. Nothing is persisted locally; nothing is retried automatically.
///
/// - Unavailable channel (no TLS identity configured, listener stopped, certificate not valid): `canCreate` is false and
///   `unavailableReason` says why. This controller never creates TLS material, keys or Keychain items.
/// - An unknown outcome is settled by READING the receipt (`settlePending`); the same request is re-sent only by an
///   explicit human gesture (`retryPendingCreate`), and the host then replays the original receipt, never a new code.
/// - After a host restart the code cannot be shown again: the receipt still proves the offer exists; the owner cancels it
///   (`cancelCurrentOffer`) and/or creates a new one.
@MainActor @Observable public final class OwnerPairingOfferEditor {
    public enum Notice: Equatable, Sendable {
        case loadFailed, baseOffline, notOwnerLoopback, hostChanged, conflict, invalidSelection
        /// The offer may exist; read the receipt (or retry the SAME request by hand). No code was shown.
        case outcomeUnknown
        case created
        /// The offer exists but its invitation text cannot be shown (anymore); cancel it and/or create a new one.
        case invitationNotRecoverable(OwnerPairingInvitationUnavailableReason?)
        case cancelled, cancelUnknown, offerNotOpen
    }
    public private(set) var status: OwnerPairingStatus?
    /// iPhone (`client-ios`) or Mac (`client-mac`): the other device's importer accepts only its own kind. No default.
    public var role: ClientRole?
    /// The Main UI's own draft type: the eight historical scopes plus each output scope only after a human turns it on.
    public var selection = PairingScopeSelection()
    /// Nil uses the host's default lifetime.
    public var ttlSeconds: Int?
    public private(set) var busy = false
    public private(set) var notice: Notice?
    public private(set) var pendingCreate: CreateOwnerPairingOfferInput?
    public private(set) var pendingCancel: CancelOwnerPairingOfferInput?
    public private(set) var record: OwnerPairingRecord?
    /// The invitation (with its one-time code) for the owner to copy/send privately. Memory only; cleared by
    /// `forgetInvitation`, cancellation, and once the offer is no longer open.
    public private(set) var invitationText: String?
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private var hostID: String?

    public init(client: HostClient) { self.client = client }

    /// Only this Mac's own host child (owner loopback) can issue invitations.
    public var isOwnerLoopback: Bool { client.ownerPairingReady }
    public var unavailableReason: OwnerPairingUnavailableReason? { status?.reason }
    public var effectiveTTLSeconds: Int? {
        guard let ttl = status?.ttl else { return nil }
        let value = ttlSeconds ?? ttl.defaultSeconds
        return (ttl.minSeconds...ttl.maxSeconds).contains(value) ? value : nil
    }
    public var draftScopes: [String] { selection.scopes }
    public var canCreate: Bool {
        isOwnerLoopback && status?.availability == .available && !busy && pendingCreate == nil && pendingCancel == nil
            && role != nil && effectiveTTLSeconds != nil && OwnerPairingScopes.isValid(selection.scopes)
    }
    public var canCancel: Bool {
        guard let record, let offer = record.receipt.offer else { return false }
        return record.receipt.operation == .create && record.receipt.outcome == .created && offer.offerId.hasPrefix("cof_")
            && record.live.offerState == .open && status != nil && !busy && pendingCreate == nil && pendingCancel == nil
    }

    private func recordFailure(_ error: Error) {
        switch error as? HostClientError {
        case .offline?, .notReady?: notice = .baseOffline
        case .forbidden?, .remotePairingUnavailable?: notice = .notOwnerLoopback
        default: notice = .loadFailed
        }
    }
    private func accept(_ value: OwnerPairingStatus) -> Bool {
        // Another base answered: nothing decided for the old one may be sent to it (the draft must be re-read).
        if let hostID, hostID != value.hostId { notice = .hostChanged; status = nil; invitationText = nil; return false }
        hostID = value.hostId; status = value; return true
    }

    /// Real status of this base's app-client channel. Never configures it.
    public func reload() async {
        guard !busy else { return }
        guard isOwnerLoopback else { notice = .notOwnerLoopback; return }
        busy = true; defer { busy = false }
        do {
            let value = try await client.ownerPairingStatus()
            if accept(value), notice == .loadFailed || notice == .baseOffline { notice = nil }
        } catch { recordFailure(error) }
    }

    /// One owner decision with the current draft. The same request id is kept until its outcome is known.
    public func create() async {
        guard let status, let role, let ttl = effectiveTTLSeconds, canCreate else {
            if status != nil, role == nil || effectiveTTLSeconds == nil { notice = .invalidSelection }
            return
        }
        let input = CreateOwnerPairingOfferInput(status: status, role: role, scopes: selection.scopes, ttlSeconds: ttl)
        invitationText = nil; record = nil
        pendingCreate = input
        await send(input)
    }
    /// Human gesture only: re-sends the SAME pending request (the host replays its original receipt).
    public func retryPendingCreate() async {
        guard let pending = pendingCreate, !busy else { return }
        await send(pending)
    }
    /// Gives up on an unconfirmed request locally. Its code (if any) was never shown and the offer expires by itself.
    public func abandonPendingCreate() { guard !busy else { return }; pendingCreate = nil }

    private func send(_ input: CreateOwnerPairingOfferInput) async {
        busy = true
        do {
            let result = try await client.createOwnerPairingOffer(input)
            busy = false
            finish(result.record, invitation: result.invitation)
            await reload()
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .outcomeUnknown
            await settlePending()
        } catch HostClientError.conflict {
            busy = false; pendingCreate = nil; notice = .conflict
            await reload()
        } catch HostClientError.invalidRequest {
            busy = false; pendingCreate = nil; notice = .invalidSelection
        } catch {
            busy = false; pendingCreate = nil; recordFailure(error)
        }
    }
    private func finish(_ value: OwnerPairingRecord, invitation: OwnerPairingInvitation?) {
        record = value; pendingCreate = nil
        if let invitation, value.receipt.outcome == .created {
            invitationText = invitation.text; notice = .created
        } else if value.receipt.outcome == .unknown {
            invitationText = nil; notice = .outcomeUnknown
        } else {
            invitationText = nil; notice = .invitationNotRecoverable(nil)
        }
    }

    /// Reads the original receipt of the pending decision (GET only). A created offer's invitation is fetched once through
    /// the pinned, finite delivery; if it is gone, the owner is told so (never a new code).
    public func settlePending() async {
        guard !busy else { return }
        if let pending = pendingCancel { await settleCancel(pending); return }
        guard let pending = pendingCreate else { return }
        busy = true
        let found: OwnerPairingRecord?
        do { found = try await client.ownerPairingRecord(clientRequestID: pending.clientRequestId) }
        catch { busy = false; notice = .outcomeUnknown; return }
        guard let found, found.receipt.requestHash == pending.requestHash, found.receipt.hostId == pending.expectedHostId else {
            busy = false; notice = .outcomeUnknown; return
        }
        record = found; pendingCreate = nil
        guard found.receipt.outcome == .created else { busy = false; invitationText = nil; notice = .outcomeUnknown; return }
        do {
            switch try await client.ownerPairingInvitation(for: found.receipt) {
            case .available(_, let invitation): invitationText = invitation.text; notice = .created
            case .unavailable(_, let reason): invitationText = nil; notice = .invitationNotRecoverable(reason)
            }
        } catch { invitationText = nil; notice = .invitationNotRecoverable(nil) }
        busy = false
        await reload()
    }

    /// Live facts of the current offer (claimed, expired…). The invitation text is dropped once the offer is not open.
    public func refreshRecord() async {
        guard !busy, let current = record else { return }
        busy = true; defer { busy = false }
        do {
            guard let value = try await client.ownerPairingRecord(clientRequestID: current.receipt.clientRequestId),
                  value.receipt == current.receipt else { notice = .loadFailed; return }
            record = value
            if value.live.offerState != .open { invitationText = nil }
        } catch { recordFailure(error) }
    }

    /// Revokes the current open invitation through the exact cancel flow (receipt, revision, request id).
    public func cancelCurrentOffer() async {
        guard canCancel, let status, let offerID = record?.receipt.offer?.offerId else { return }
        let input = CancelOwnerPairingOfferInput(status: status, offerID: offerID)
        pendingCancel = input
        await sendCancel(input)
    }
    /// Human gesture only: re-sends the SAME pending cancellation.
    public func retryPendingCancel() async {
        guard let pending = pendingCancel, !busy else { return }
        await sendCancel(pending)
    }
    private func sendCancel(_ input: CancelOwnerPairingOfferInput) async {
        busy = true
        do {
            let value = try await client.cancelOwnerPairingOffer(input)
            busy = false; pendingCancel = nil; invitationText = nil; record = value; notice = .cancelled
            await reload()
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .cancelUnknown
            await settleCancel(input)
        } catch HostClientError.conflict {
            busy = false; pendingCancel = nil; notice = .offerNotOpen
            await reload(); await refreshRecord()
        } catch {
            busy = false; pendingCancel = nil; recordFailure(error)
        }
    }
    private func settleCancel(_ pending: CancelOwnerPairingOfferInput) async {
        busy = true
        let found = try? await client.ownerPairingRecord(clientRequestID: pending.clientRequestId)
        busy = false
        guard let found, found.receipt.requestHash == pending.requestHash, found.receipt.operation == .cancel else { notice = .cancelUnknown; return }
        pendingCancel = nil; invitationText = nil; record = found
        notice = found.receipt.outcome == .cancelled ? .cancelled : .cancelUnknown
        await reload()
    }

    /// Drops the invitation text from memory (after the owner copied or sent it).
    public func forgetInvitation() { invitationText = nil }
}
#endif
