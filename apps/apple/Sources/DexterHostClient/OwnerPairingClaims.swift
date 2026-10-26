import CryptoKit
import DexterClientIdentity
import Foundation

// Owner review of app-client claims of THIS base: after another iPhone/Mac used an invitation, the human owner lists,
// inspects, approves or rejects its claim without the CLI. Mirrors `packages/contracts/src/owner-pairing-claims.ts`
// (version 1). Owner loopback only: a paired or unpaired client is refused before any byte is sent; every request uses
// the no-redirect transport with no cache. Role and scopes are always the offer's: a decision cannot add a scope and
// creates no grant. A decision names the exact claim shown (claim pin + certificate pin) and the claims revision.

public struct OwnerPairingClaimBinding: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case active, revoked }
    public let deviceId: String
    public let role: ClientRole
    public let scopes: [String]
    public let fingerprint: String
    public let generation: Int, revision: Int
    public let status: Status
}
public struct OwnerPairingClaim: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case pair, rotate }
    public enum Status: String, Codable, Sendable { case pending, approving, approved, rejected, failed, expired }
    public let claimId: String, offerId: String
    public let kind: Kind
    public let role: ClientRole
    /// Exactly the scopes of the owner's offer.
    public let scopes: [String]
    public let targetDeviceId: String?
    public let approvedDeviceId: String?
    /// SHA-256 pin of the other device's certificate: the owner compares it with what that device shows.
    public let clientFingerprint: String
    /// Untrusted label typed on the other device.
    public let name: String
    public let status: Status
    public let createdAt: Int64, expiresAt: Int64
    public let decidedAt: Int64?
    public let claimPin: String
    /// The invitation created by the owner app that this claim used (nil when the offer came from the CLI).
    public let offerClientRequestId: String?
    public let binding: OwnerPairingClaimBinding?
    public var id: String { claimId }
    var isValid: Bool {
        ownerPairingClaimIDIsValid(claimId) && ownerPairingOfferIDIsValid(offerId) && OwnerPairingScopes.isValid(scopes)
            && outputHashIsValid(clientFingerprint) && outputHashIsValid(claimPin) && !name.isEmpty && name.utf16.count <= 120
            && (kind == .rotate) == (targetDeviceId != nil) && (status == .approved) == (approvedDeviceId != nil)
            && (offerClientRequestId.map(ownerPairingRequestIDIsValid) ?? true)
            && (binding.map { OwnerPairingScopes.isValid($0.scopes) && outputHashIsValid($0.fingerprint) && $0.generation >= 1 } ?? true)
    }
}
public struct OwnerPairingClaimsList: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Sendable { case channelUnconfigured = "app_client_channel_unconfigured", hostClosing = "host_closing" }
    public let version: Int, hostId: String, revision: Int
    /// Journal continuity pin every decision names; nil while unavailable.
    public let journalPin: String?
    public let availability: OwnerPairingAvailability
    public let reason: Reason?
    /// Pending, unexpired claims, oldest first.
    public let items: [OwnerPairingClaim]
    public let truncated: Bool
    var isValid: Bool {
        version == 1 && outputHostIDIsValid(hostId) && revision >= 1 && (availability == .available) == (reason == nil) && items.count <= 50
            && (availability == .available) == (journalPin != nil) && (journalPin.map(outputHashIsValid) ?? true)
            && items.allSatisfy { $0.isValid && $0.status == .pending } && Set(items.map(\.claimId)).count == items.count
            && (availability == .available || items.isEmpty)
    }
}
public enum OwnerPairingDecision: String, Codable, Sendable { case approve, reject }

/// POST /v1/owner/app-client-pairing/claims/:claimId/decision. Keep the same `clientRequestId` for every retry of ONE decision.
public struct DecideOwnerPairingClaimInput: Encodable, Equatable, Sendable {
    public let expectedHostId: String, expectedRevision: Int, clientRequestId: String
    /// The list's journal pin: a decision formed before a restore or a lost journal is refused, never re-executed.
    public let expectedJournalPin: String
    public let decision: OwnerPairingDecision
    public let expectedClaimPin: String, expectedClientFingerprint: String
    public let claimID: String
    private enum CodingKeys: String, CodingKey { case expectedHostId, expectedRevision, expectedJournalPin, clientRequestId, decision, expectedClaimPin, expectedClientFingerprint }
    /// Built from the list the owner saw and the exact claim shown (its pins), never from free input.
    public init(list: OwnerPairingClaimsList, claim: OwnerPairingClaim, decision: OwnerPairingDecision, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostId = list.hostId; expectedRevision = list.revision; expectedJournalPin = list.journalPin ?? ""
        self.decision = decision; self.clientRequestId = clientRequestId
        expectedClaimPin = claim.claimPin; expectedClientFingerprint = claim.clientFingerprint; claimID = claim.claimId
    }
    var isValid: Bool {
        outputHostIDIsValid(expectedHostId) && expectedRevision >= 1 && ownerPairingRequestIDIsValid(clientRequestId) && ownerPairingClaimIDIsValid(claimID)
            && outputHashIsValid(expectedClaimPin) && outputHashIsValid(expectedClientFingerprint) && outputHashIsValid(expectedJournalPin)
    }
    /// Same canonical form as the host (sorted keys, includes the claim id of the path).
    public var requestHash: String? {
        guard let data = try? JSONSerialization.data(withJSONObject: ["claimId": claimID, "clientRequestId": clientRequestId, "decision": decision.rawValue,
            "expectedClaimPin": expectedClaimPin, "expectedClientFingerprint": expectedClientFingerprint, "expectedHostId": expectedHostId,
            "expectedJournalPin": expectedJournalPin, "expectedRevision": expectedRevision] as [String: Any], options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
public struct OwnerPairingDecisionReceipt: Codable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable { case approved, rejected, notApplied = "not_applied", failed, unknown }
    public struct Claim: Codable, Equatable, Sendable {
        public let claimId: String, offerId: String
        public let kind: OwnerPairingClaim.Kind
        public let role: ClientRole
        public let scopes: [String]
        public let targetDeviceId: String?
        public let clientFingerprint: String, name: String, claimPin: String
    }
    public struct Binding: Codable, Equatable, Sendable {
        public let deviceId: String
        public let role: ClientRole
        public let scopes: [String]
        public let fingerprint: String
        public let generation: Int, revision: Int
    }
    public let version: Int, hostId: String, clientRequestId: String, requestHash: String
    public let operation: OwnerPairingDecision
    public let previousRevision: Int, revision: Int
    public let outcome: Outcome
    public let claim: Claim
    public let binding: Binding?
    /// Always 0: approving a device grants nothing to any bot.
    public let grantsCreated: Int
    public let createdAt: Int64
    var isValid: Bool {
        version == 1 && outputHostIDIsValid(hostId) && ownerPairingRequestIDIsValid(clientRequestId) && outputHashIsValid(requestHash)
            && previousRevision >= 1 && revision == previousRevision + 1 && grantsCreated == 0 && OwnerPairingScopes.isValid(claim.scopes)
            && (outcome == .approved) == (binding != nil) && (outcome != .approved || operation == .approve) && (outcome != .rejected || operation == .reject)
            // Approval never changes the offer's role/scopes or the certificate the owner was shown.
            && binding.map { $0.role == claim.role && $0.scopes == claim.scopes && $0.fingerprint == claim.clientFingerprint } ?? true
    }
    /// The receipt belongs to exactly this decision (host, request id/hash, revision, claim and pins).
    public func matches(_ input: DecideOwnerPairingClaimInput) -> Bool {
        isValid && hostId == input.expectedHostId && clientRequestId == input.clientRequestId && requestHash == input.requestHash
            && operation == input.decision && previousRevision == input.expectedRevision && claim.claimId == input.claimID
            && claim.claimPin == input.expectedClaimPin && claim.clientFingerprint == input.expectedClientFingerprint
    }
}
public struct OwnerPairingDecisionRecord: Codable, Equatable, Sendable {
    public let receipt: OwnerPairingDecisionReceipt
    /// The live claim (approved/rejected/…); nil when the registry no longer knows it.
    public let claim: OwnerPairingClaim?
}

public extension HostClient {
    func ownerPairingClaims() async throws -> OwnerPairingClaimsList {
        guard ownerPairingReady else { throw HostClientError.forbidden }
        let value: OwnerPairingClaimsList = try await request("/v1/owner/app-client-pairing/claims", timeout: 15,
                                                              cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }
        return value
    }
    func ownerPairingClaim(id: String) async throws -> OwnerPairingClaim {
        guard ownerPairingReady else { throw HostClientError.forbidden }
        guard ownerPairingClaimIDIsValid(id) else { throw HostClientError.invalidRequest }
        let value: OwnerPairingClaim = try await request("/v1/owner/app-client-pairing/claims/\(id)", timeout: 15,
                                                         cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.isValid, value.claimId == id else { throw HostClientError.contractMismatch }
        return value
    }
    /// One owner decision. Unknown outcome (transport, 5xx, invalid answer) → `mutationOutcomeUnknown`: read the decision
    /// receipt; never re-post automatically. An exact replay returns the original receipt.
    func decideOwnerPairingClaim(_ input: DecideOwnerPairingClaimInput) async throws -> OwnerPairingDecisionRecord {
        guard ownerPairingReady else { throw HostClientError.forbidden }
        guard input.isValid, input.requestHash != nil else { throw HostClientError.invalidRequest }
        let value: OwnerPairingDecisionRecord
        do {
            value = try await request("/v1/owner/app-client-pairing/claims/\(input.claimID)/decision", method: "POST", body: input, timeout: 30,
                                      cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        } catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch, .notReady: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
        guard value.receipt.matches(input), value.claim.map({ $0.isValid && $0.claimId == input.claimID }) ?? true else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    /// Original decision receipt plus the live claim. Nil means unconfirmed, never "did not happen".
    func ownerPairingDecision(clientRequestID: String) async throws -> OwnerPairingDecisionRecord? {
        guard ownerPairingReady else { throw HostClientError.forbidden }
        guard ownerPairingRequestIDIsValid(clientRequestID) else { throw HostClientError.invalidRequest }
        do {
            let value: OwnerPairingDecisionRecord = try await request("/v1/owner/app-client-pairing/decisions/\(clientRequestID)", timeout: 15,
                                                                      cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
            guard value.receipt.isValid, value.receipt.clientRequestId == clientRequestID else { throw HostClientError.contractMismatch }
            return value
        } catch HostClientError.notFound { return nil }
    }
}

func ownerPairingClaimIDIsValid(_ value: String) -> Bool {
    value.range(of: "^ccl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil
}
