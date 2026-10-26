#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import Observation

/// Focused owner controller (no UI) for "Pedidos de aparelhos" on THIS Mac's base: lists the claims made with this base's
/// invitations and lets the owner approve or reject the EXACT claim shown (kind, role, scopes, certificate pin, name).
/// Nothing is persisted locally; nothing is retried automatically.
///
/// - Unavailable channel (no TLS identity configured): `unavailableReason` says so; no decision can be sent. This controller
///   never creates TLS material, keys, identities or Keychain items, and never rotates anything.
/// - A decision is built from the list the owner saw (its revision) and the claim's pins. An unknown outcome is settled by
///   READING the decision receipt (`settlePending`); the same request is re-sent only by a human gesture.
/// - Approving grants nothing to any bot and never adds a scope; the scopes are the offer's.
@MainActor @Observable public final class OwnerPairingClaimsEditor {
    public enum Notice: Equatable, Sendable {
        case loadFailed, baseOffline, notOwnerLoopback, hostChanged
        /// The list or the claim changed (revision, pins, no longer pending): re-read before deciding.
        case conflict
        case invalidRequest
        /// The decision may have been applied; read the receipt (or retry the SAME request by hand).
        case outcomeUnknown
        case decided(OwnerPairingDecisionReceipt.Outcome)
    }
    public private(set) var list: OwnerPairingClaimsList?
    public private(set) var busy = false
    public private(set) var notice: Notice?
    public private(set) var pendingDecision: DecideOwnerPairingClaimInput?
    public private(set) var lastDecision: OwnerPairingDecisionRecord?
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private var hostID: String?

    public init(client: HostClient) { self.client = client }

    public var isOwnerLoopback: Bool { client.ownerPairingReady }
    public var claims: [OwnerPairingClaim] { list?.items ?? [] }
    public var unavailableReason: OwnerPairingClaimsList.Reason? { list?.reason }
    public var canDecide: Bool { isOwnerLoopback && list?.availability == .available && !busy && pendingDecision == nil }

    private func recordFailure(_ error: Error) {
        switch error as? HostClientError {
        case .offline?, .notReady?: notice = .baseOffline
        case .forbidden?, .remotePairingUnavailable?: notice = .notOwnerLoopback
        default: notice = .loadFailed
        }
    }
    private func accept(_ value: OwnerPairingClaimsList) -> Bool {
        // Another base answered: nothing decided for the old one may be sent to it.
        if let hostID, hostID != value.hostId { notice = .hostChanged; list = nil; return false }
        hostID = value.hostId; list = value; return true
    }

    /// Pending claims of this base (real channel state). Never configures anything.
    public func reload() async {
        guard !busy else { return }
        guard isOwnerLoopback else { notice = .notOwnerLoopback; return }
        busy = true; defer { busy = false }
        do {
            let value = try await client.ownerPairingClaims()
            if accept(value), notice == .loadFailed || notice == .baseOffline || notice == .conflict { notice = nil }
        } catch { recordFailure(error) }
    }
    /// Fresh facts of one claim (any state). Returns nil when it cannot be read.
    public func inspect(claimID: String) async -> OwnerPairingClaim? {
        guard !busy, isOwnerLoopback else { return nil }
        busy = true; defer { busy = false }
        do { return try await client.ownerPairingClaim(id: claimID) } catch { recordFailure(error); return nil }
    }

    /// Human gesture on a claim from the CURRENT list (same pins). The decision keeps its request id until known.
    public func approve(_ claim: OwnerPairingClaim) async { await decide(claim, .approve) }
    public func reject(_ claim: OwnerPairingClaim) async { await decide(claim, .reject) }
    private func decide(_ claim: OwnerPairingClaim, _ decision: OwnerPairingDecision) async {
        guard canDecide, let list, let shown = list.items.first(where: { $0.claimId == claim.claimId }),
              shown.claimPin == claim.claimPin, shown.clientFingerprint == claim.clientFingerprint else { notice = .conflict; return }
        let input = DecideOwnerPairingClaimInput(list: list, claim: shown, decision: decision)
        pendingDecision = input
        await send(input)
    }
    /// Human gesture only: re-sends the SAME pending decision (the host replays its original receipt).
    public func retryPendingDecision() async {
        guard let pending = pendingDecision, !busy else { return }
        await send(pending)
    }
    /// Gives up locally on an unconfirmed decision (the live claim still tells what happened).
    public func abandonPendingDecision() { guard !busy else { return }; pendingDecision = nil }

    private func send(_ input: DecideOwnerPairingClaimInput) async {
        busy = true
        do {
            let value = try await client.decideOwnerPairingClaim(input)
            busy = false; finish(value)
            await reload()
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .outcomeUnknown
            await settlePending()
        } catch HostClientError.conflict {
            busy = false; pendingDecision = nil; notice = .conflict
            await reload()
        } catch HostClientError.invalidRequest {
            busy = false; pendingDecision = nil; notice = .invalidRequest
        } catch {
            busy = false; pendingDecision = nil; recordFailure(error)
        }
    }
    private func finish(_ value: OwnerPairingDecisionRecord) {
        lastDecision = value; pendingDecision = nil
        notice = value.receipt.outcome == .unknown ? .outcomeUnknown : .decided(value.receipt.outcome)
    }
    /// Reads the original receipt of the pending decision (GET only, same request id and hash).
    public func settlePending() async {
        guard let pending = pendingDecision, !busy else { return }
        busy = true
        let found = try? await client.ownerPairingDecision(clientRequestID: pending.clientRequestId)
        busy = false
        guard let found, found.receipt.matches(pending) else { notice = .outcomeUnknown; return }
        finish(found)
        await reload()
    }
}
#endif
