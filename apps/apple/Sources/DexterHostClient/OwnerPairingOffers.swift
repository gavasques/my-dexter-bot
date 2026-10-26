import CryptoKit
import DexterClientIdentity
import Foundation

// Owner pairing offers of THIS base: the human owner creates (and cancels) a one-time invitation for another iPhone or
// Mac without the `dexter app-client offer` CLI. Mirrors `packages/contracts/src/owner-pairing-offer.ts` (version 1).
// Owner loopback only: a paired or unpaired client is refused before any byte is sent. Every request goes through the
// no-redirect transport with no cache. The invitation text carries the one-time code: it is kept in memory only, never
// in a description, log, notice or persisted state, and is verified against the receipt's SHA-256 pin before use.

public enum OwnerPairingAvailability: String, Codable, Sendable { case available, unavailable }
public enum OwnerPairingUnavailableReason: String, Codable, Sendable {
    case channelUnconfigured = "app_client_channel_unconfigured"
    case listenerNotListening = "app_client_listener_not_listening"
    case certificateNotValid = "app_client_certificate_not_valid"
    case offerTTLTooShort = "app_client_offer_ttl_too_short"
    case hostClosing = "host_closing"
}
public struct OwnerPairingChannel: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case listening, notListening = "not_listening", unconfigured }
    public let status: Status
    public let installationId: String?
    /// Exact address the other device dials (from the host's own listener), never chosen here.
    public let hostUrl: String?
    public let hostFingerprint: String?
    public let certificateNotAfter: Int64?
}
public struct OwnerPairingTTL: Codable, Equatable, Sendable { public let minSeconds: Int, maxSeconds: Int, defaultSeconds: Int }
public struct OwnerPairingScopeLists: Codable, Equatable, Sendable { public let historical: [String]; public let optIn: [String] }
public struct OwnerPairingLimits: Codable, Equatable, Sendable { public let invitationDeliveries: Int; public let invitationBytes: Int }
public struct OwnerPairingStatus: Codable, Equatable, Sendable {
    public let version: Int, hostId: String, revision: Int
    /// Journal continuity pin (authority epoch + journal instance); every mutation names it. Nil while unavailable.
    public let journalPin: String?
    public let availability: OwnerPairingAvailability
    public let reason: OwnerPairingUnavailableReason?
    public let channel: OwnerPairingChannel
    /// Nil while the channel is unconfigured. `maxSeconds` is the host's configured offer lifetime.
    public let ttl: OwnerPairingTTL?
    public let roles: [String]
    public let scopes: OwnerPairingScopeLists
    public let limits: OwnerPairingLimits
    var isValid: Bool {
        guard version == 1, outputHostIDIsValid(hostId), revision >= 1, (availability == .available) == (reason == nil),
              journalPin.map(outputHashIsValid) ?? true,
              scopes.historical == OwnerPairingScopes.historical, scopes.optIn == OwnerPairingScopes.optIn,
              ttl.map({ 1 <= $0.minSeconds && $0.minSeconds <= $0.defaultSeconds && $0.defaultSeconds <= $0.maxSeconds && $0.maxSeconds <= 3600 }) ?? true
        else { return false }
        if availability == .available {
            return channel.status == .listening && channel.installationId == hostId && channel.hostUrl != nil
                && channel.hostFingerprint.map(outputHashIsValid) == true && ttl != nil && journalPin != nil
        }
        return true
    }
}

/// The closed scope vocabulary of an owner offer. The eight historical scopes are named one by one (never `allCases`);
/// `outputs.*`, `connections.*` and `mcp.*` are separate opt-ins; no `.manage` includes its `.read` (at most 14 scopes).
public enum OwnerPairingScopes {
    public static let historical = ["approvals.decide", "approvals.read", "chat.read", "chat.write",
                                    "devices.manage", "devices.read", "grants.manage", "grants.read"]
    public static let optIn = ["connections.manage", "connections.read", "mcp.manage", "mcp.read", "outputs.manage", "outputs.read"]
    /// Unique, sorted (as the registry and the invitation importer require) and closed.
    public static func isValid(_ scopes: [String]) -> Bool {
        let closed = Set(historical + optIn)
        return scopes.count <= closed.count && scopes == scopes.sorted() && Set(scopes).count == scopes.count && scopes.allSatisfy(closed.contains)
    }
}

/// POST /v1/owner/app-client-pairing/offers. Keep the same `clientRequestId` for every retry of ONE owner decision.
public struct CreateOwnerPairingOfferInput: Encodable, Equatable, Sendable {
    public let expectedHostId: String, expectedRevision: Int, clientRequestId: String
    /// The status's journal pin: after a restore or a lost journal it changes and this request is refused, never re-executed.
    public let expectedJournalPin: String
    public let role: ClientRole
    public let scopes: [String]
    public let ttlSeconds: Int
    public init(status: OwnerPairingStatus, role: ClientRole, scopes: [String], ttlSeconds: Int, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostId = status.hostId; expectedRevision = status.revision; expectedJournalPin = status.journalPin ?? ""
        self.role = role; self.scopes = scopes; self.ttlSeconds = ttlSeconds
        self.clientRequestId = clientRequestId
    }
    var isValid: Bool {
        outputHostIDIsValid(expectedHostId) && expectedRevision >= 1 && ownerPairingRequestIDIsValid(clientRequestId) && outputHashIsValid(expectedJournalPin)
            && OwnerPairingScopes.isValid(scopes) && (60...3600).contains(ttlSeconds)
    }
    /// Same canonical form as the host (sorted keys, no spaces): binds the receipt to this exact request.
    public var requestHash: String? {
        ownerPairingCanonicalHash(["clientRequestId": clientRequestId, "expectedHostId": expectedHostId, "expectedJournalPin": expectedJournalPin,
                                   "expectedRevision": expectedRevision, "role": role.rawValue, "scopes": scopes, "ttlSeconds": ttlSeconds])
    }
}
/// POST /v1/owner/app-client-pairing/offers/:offerId/cancel (only offers created through this flow, while open).
public struct CancelOwnerPairingOfferInput: Encodable, Equatable, Sendable {
    public let expectedHostId: String, expectedRevision: Int, clientRequestId: String
    public let expectedJournalPin: String
    public let offerID: String
    private enum CodingKeys: String, CodingKey { case expectedHostId, expectedRevision, expectedJournalPin, clientRequestId }
    public init(status: OwnerPairingStatus, offerID: String, clientRequestId: String = UUID().uuidString.lowercased()) {
        expectedHostId = status.hostId; expectedRevision = status.revision; expectedJournalPin = status.journalPin ?? ""
        self.offerID = offerID; self.clientRequestId = clientRequestId
    }
    var isValid: Bool {
        outputHostIDIsValid(expectedHostId) && expectedRevision >= 1 && ownerPairingRequestIDIsValid(clientRequestId) && ownerPairingOfferIDIsValid(offerID)
            && outputHashIsValid(expectedJournalPin)
    }
    public var requestHash: String? {
        ownerPairingCanonicalHash(["clientRequestId": clientRequestId, "expectedHostId": expectedHostId, "expectedJournalPin": expectedJournalPin,
                                   "expectedRevision": expectedRevision, "offerId": offerID])
    }
}

public struct OwnerPairingOffer: Codable, Equatable, Sendable {
    public let offerId: String
    public let kind: String
    public let role: ClientRole
    public let scopes: [String]
    public let expiresAt: Int64
    public let installationId: String, hostUrl: String, hostFingerprint: String
}
/// Durable receipt (never the code). `unknown`: reserved but not confirmed; its code (if any) was never delivered.
public struct OwnerPairingReceipt: Codable, Equatable, Sendable {
    public enum Operation: String, Codable, Sendable { case create, cancel }
    public enum Outcome: String, Codable, Sendable { case created, cancelled, unknown }
    public let version: Int, hostId: String, clientRequestId: String, requestHash: String
    public let operation: Operation
    public let previousRevision: Int, revision: Int
    public let outcome: Outcome
    public let offer: OwnerPairingOffer?
    public let invitationSha256: String?
    /// Always 0: pairing grants nothing to any bot.
    public let grantsCreated: Int
    public let createdAt: Int64
    var isValid: Bool {
        version == 1 && outputHostIDIsValid(hostId) && ownerPairingRequestIDIsValid(clientRequestId) && outputHashIsValid(requestHash)
            && revision == previousRevision + 1 && previousRevision >= 1 && grantsCreated == 0
            && (outcome != .created || (operation == .create && offer != nil && invitationSha256.map(outputHashIsValid) == true))
            && (outcome != .cancelled || (operation == .cancel && offer != nil))
            && offer.map { ownerPairingOfferIDIsValid($0.offerId) && $0.kind == "pair" && OwnerPairingScopes.isValid($0.scopes) && $0.installationId == hostId } ?? true
    }
    func matches(_ input: CreateOwnerPairingOfferInput) -> Bool {
        isValid && operation == .create && hostId == input.expectedHostId && clientRequestId == input.clientRequestId && requestHash == input.requestHash
            && previousRevision == input.expectedRevision
            && (outcome == .unknown || (offer?.role == input.role && offer?.scopes == input.scopes))
    }
    func matches(_ input: CancelOwnerPairingOfferInput) -> Bool {
        isValid && operation == .cancel && hostId == input.expectedHostId && clientRequestId == input.clientRequestId && requestHash == input.requestHash
            && previousRevision == input.expectedRevision && (offer == nil || offer?.offerId == input.offerID)
    }
}
public struct OwnerPairingLive: Codable, Equatable, Sendable {
    public enum OfferState: String, Codable, Sendable { case open, claimed, cancelled, exhausted, expired, unknown }
    public enum Retention: String, Codable, Sendable { case retained, notRetained = "not_retained" }
    public let offerState: OfferState
    /// Whether THIS host process still holds the invitation text (never after a restart).
    public let invitation: Retention
}
public struct OwnerPairingRecord: Codable, Equatable, Sendable { public let receipt: OwnerPairingReceipt; public let live: OwnerPairingLive }
/// The exact text the other device pastes ("Conectar a outra base…"). Secret: redacted from every description/mirror.
public struct OwnerPairingInvitation: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let text: String
    public let sha256: String
    public let deliveriesRemaining: Int
    public var description: String { "OwnerPairingInvitation(sha256: \(sha256), deliveriesRemaining: \(deliveriesRemaining))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["sha256": sha256, "deliveriesRemaining": deliveriesRemaining]) }
    /// Exactly the `dexter app-client offer` bundle of `receipt`: pin, 12 keys, same offer, role, scopes, host and expiry.
    func isValid(for receipt: OwnerPairingReceipt) -> Bool {
        guard let offer = receipt.offer, receipt.outcome == .created, text.utf8.count <= 8192, sha256 == receipt.invitationSha256,
              SHA256.hash(data: Data(text.utf8)).map({ String(format: "%02x", $0) }).joined() == sha256, deliveriesRemaining >= 0,
              text.hasSuffix("\n"), let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              Set(object.keys) == ["protocol", "installationId", "hostUrl", "hostCertificateDER", "hostFingerprint", "offerId", "kind", "role", "scopes",
                                   "deviceId", "expiresAt", "code"],
              object["protocol"] as? String == "dexter-app-client-v1", object["kind"] as? String == "pair", object["deviceId"] is NSNull,
              object["offerId"] as? String == offer.offerId, object["installationId"] as? String == receipt.hostId,
              object["hostUrl"] as? String == offer.hostUrl, object["hostFingerprint"] as? String == offer.hostFingerprint,
              object["role"] as? String == offer.role.rawValue, object["scopes"] as? [String] == offer.scopes,
              (object["expiresAt"] as? NSNumber)?.int64Value == offer.expiresAt,
              let der = object["hostCertificateDER"] as? String, Data(base64Encoded: der)?.base64EncodedString() == der,
              let code = object["code"] as? String, code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { return false }
        return true
    }
}
public struct OwnerPairingOfferResult: Codable, Equatable, Sendable {
    public let record: OwnerPairingRecord
    /// Nil when the host no longer retains the text (restart, delivery limit, claimed/expired): it is never re-issued.
    public let invitation: OwnerPairingInvitation?
}
public enum OwnerPairingInvitationUnavailableReason: String, Codable, Sendable {
    case expired, claimed, cancelled, exhausted, notRetained = "not_retained", deliveryLimit = "delivery_limit", outcomeUnknown = "outcome_unknown"
}
public enum OwnerPairingInvitationRead: Equatable, Sendable {
    case available(offerID: String, invitation: OwnerPairingInvitation)
    case unavailable(offerID: String?, reason: OwnerPairingInvitationUnavailableReason)
}
private struct OwnerPairingInvitationReadWire: Decodable, Sendable {
    let version: Int, hostId: String, clientRequestId: String, offerId: String?
    let availability: OwnerPairingAvailability
    let invitation: OwnerPairingInvitation?
    let reason: OwnerPairingInvitationUnavailableReason?
}

public extension HostClient {
    /// Real channel facts of THIS base (listener, certificate, installation). Never creates TLS material or keys.
    func ownerPairingStatus() async throws -> OwnerPairingStatus {
        try requireOwnerPairingLoopback()
        let value: OwnerPairingStatus = try await request("/v1/owner/app-client-pairing/status", timeout: 15,
                                                         cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        guard value.isValid else { throw HostClientError.contractMismatch }
        return value
    }
    /// One owner decision. Unknown outcome (transport, 5xx, invalid answer) → `mutationOutcomeUnknown`: read the receipt;
    /// never re-post automatically. An exact replay returns the original receipt and never a new code.
    func createOwnerPairingOffer(_ input: CreateOwnerPairingOfferInput) async throws -> OwnerPairingOfferResult {
        try requireOwnerPairingLoopback()
        guard input.isValid, input.requestHash != nil else { throw HostClientError.invalidRequest }
        let value: OwnerPairingOfferResult
        do {
            value = try await request("/v1/owner/app-client-pairing/offers", method: "POST", body: input, timeout: 30,
                                      cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        } catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch, .notReady: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
        guard value.record.receipt.matches(input), value.invitation.map({ $0.isValid(for: value.record.receipt) }) ?? true else {
            throw HostClientError.mutationOutcomeUnknown
        }
        return value
    }
    /// Original receipt plus live facts. Nil means unconfirmed, never "did not happen".
    func ownerPairingRecord(clientRequestID: String) async throws -> OwnerPairingRecord? {
        try requireOwnerPairingLoopback()
        guard ownerPairingRequestIDIsValid(clientRequestID) else { throw HostClientError.invalidRequest }
        do {
            let value: OwnerPairingRecord = try await request("/v1/owner/app-client-pairing/receipts/\(clientRequestID)", timeout: 15,
                                                              cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
            guard value.receipt.isValid, value.receipt.clientRequestId == clientRequestID else { throw HostClientError.contractMismatch }
            return value
        } catch HostClientError.notFound { return nil }
    }
    /// Finite delivery pinned to the receipt's exact request; verified against its SHA-256 pin before it is returned.
    func ownerPairingInvitation(for receipt: OwnerPairingReceipt) async throws -> OwnerPairingInvitationRead {
        try requireOwnerPairingLoopback()
        guard receipt.isValid, receipt.operation == .create else { throw HostClientError.invalidRequest }
        let wire: OwnerPairingInvitationReadWire = try await request("/v1/owner/app-client-pairing/receipts/\(receipt.clientRequestId)/invitation",
            query: [URLQueryItem(name: "requestHash", value: receipt.requestHash)], timeout: 15, cachePolicy: .reloadIgnoringLocalCacheData,
            localAttachmentRequest: true)
        guard wire.version == 1, wire.hostId == receipt.hostId, wire.clientRequestId == receipt.clientRequestId else { throw HostClientError.contractMismatch }
        switch wire.availability {
        case .available:
            guard let invitation = wire.invitation, wire.reason == nil, let offerID = wire.offerId, offerID == receipt.offer?.offerId,
                  invitation.isValid(for: receipt) else { throw HostClientError.contractMismatch }
            return .available(offerID: offerID, invitation: invitation)
        case .unavailable:
            guard wire.invitation == nil, let reason = wire.reason, wire.offerId == receipt.offer?.offerId else { throw HostClientError.contractMismatch }
            return .unavailable(offerID: wire.offerId, reason: reason)
        }
    }
    /// Cancels one open offer created through this flow. Unknown outcome → read the cancel receipt.
    func cancelOwnerPairingOffer(_ input: CancelOwnerPairingOfferInput) async throws -> OwnerPairingRecord {
        try requireOwnerPairingLoopback()
        guard input.isValid, input.requestHash != nil else { throw HostClientError.invalidRequest }
        let value: OwnerPairingRecord
        do {
            value = try await request("/v1/owner/app-client-pairing/offers/\(input.offerID)/cancel", method: "POST", body: input, timeout: 30,
                                      cachePolicy: .reloadIgnoringLocalCacheData, localAttachmentRequest: true)
        } catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch, .notReady: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
        guard value.receipt.matches(input) else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    /// Only this Mac's own host child (owner loopback) can issue invitations; never a paired or unpaired base.
    var ownerPairingReady: Bool { if case .loopbackDevelopment = accessPolicy { return true }; return false }
    private func requireOwnerPairingLoopback() throws { guard ownerPairingReady else { throw HostClientError.forbidden } }
}

func ownerPairingRequestIDIsValid(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
}
func ownerPairingOfferIDIsValid(_ value: String) -> Bool {
    value.range(of: "^cof_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil
}
private func ownerPairingCanonicalHash(_ value: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
