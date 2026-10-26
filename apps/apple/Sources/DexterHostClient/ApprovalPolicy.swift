import Foundation
import CryptoKit

/// An owner policy approves execution within existing grants. It never grants new authority.
public enum BotApprovalPolicyMode: String, Codable, CaseIterable, Sendable {
    case ask
    case acceptEdits = "accept_edits"
    case approveAll = "approve_all"
    case fullAccess = "full_access"
}

/// Durable host authorization evidence; this is not a new client-side grant or human decision.
public enum ActionAuthorizationSource: String, Codable, Sendable {
    case exactOwner = "exact_owner"
    case ownerPolicy = "owner_policy"
    case boundedGrant = "bounded_grant"
    case threadPolicy = "thread_policy"
    case ownerType = "owner_type"
}
public struct ActionAuthorization: Codable, Equatable, Sendable {
    public let source: ActionAuthorizationSource
    public let ownerId: String
    public let policyRevision: Int?
    public let policyReceiptId: String?
    public let eligibleScopeVersion: String?
    public init(source: ActionAuthorizationSource, ownerId: String, policyRevision: Int? = nil,
                policyReceiptId: String? = nil, eligibleScopeVersion: String? = nil) {
        self.source = source; self.ownerId = ownerId; self.policyRevision = policyRevision
        self.policyReceiptId = policyReceiptId; self.eligibleScopeVersion = eligibleScopeVersion
    }
}

public struct BotApprovalPolicy: Codable, Equatable, Sendable {
    public static let executionScopeVersion = "d03.execution.v1"
    public let hostId: String
    public let botId: String
    public let ownerId: String
    public let mode: BotApprovalPolicyMode
    public let revision: Int
    public let eligibleScopeVersion: String
    public let updatedAt: Int64
    public let receiptId: String?

    public init(hostId: String, botId: String, ownerId: String, mode: BotApprovalPolicyMode,
                revision: Int, eligibleScopeVersion: String = executionScopeVersion, updatedAt: Int64, receiptId: String?) {
        self.hostId = hostId; self.botId = botId; self.ownerId = ownerId; self.mode = mode
        self.revision = revision; self.eligibleScopeVersion = eligibleScopeVersion
        self.updatedAt = updatedAt; self.receiptId = receiptId
    }
    public var isValid: Bool {
        approvalIdentityIsValid(hostId) && approvalIdentityIsValid(botId) && approvalIdentityIsValid(ownerId) &&
        revision >= 0 && revision <= 9_007_199_254_740_991 && updatedAt >= 0 && updatedAt <= 9_007_199_254_740_991 &&
        eligibleScopeVersion == Self.executionScopeVersion &&
        (receiptId.map(approvalIdentityIsValid) ?? (revision == 0 && mode == .ask))
    }
}

/// Exact recovery input; owner and bot identities come from the host's route and stored bot.
public struct PatchBotApprovalPolicyInput: Codable, Equatable, Sendable {
    public let expectedHostId: String
    public let clientRequestId: String
    public let expectedRevision: Int
    public let mode: BotApprovalPolicyMode
    public let eligibleScopeVersion: String
    public init(expectedHostId: String, clientRequestId: String, expectedRevision: Int,
                mode: BotApprovalPolicyMode, eligibleScopeVersion: String = BotApprovalPolicy.executionScopeVersion) {
        self.expectedHostId = expectedHostId; self.clientRequestId = clientRequestId
        self.expectedRevision = expectedRevision; self.mode = mode; self.eligibleScopeVersion = eligibleScopeVersion
    }
    public var isValid: Bool {
        approvalIdentityIsValid(expectedHostId) && approvalIdentityIsValid(clientRequestId) &&
        expectedRevision >= 0 && expectedRevision < 9_007_199_254_740_991 &&
        eligibleScopeVersion == BotApprovalPolicy.executionScopeVersion
    }
}

public struct BotApprovalPolicyRevocationEffects: Codable, Equatable, Sendable {
    public let blockedActionIds: [String]
    public let abortedActionIds: [String]
    public init(blockedActionIds: [String], abortedActionIds: [String]) {
        self.blockedActionIds = blockedActionIds; self.abortedActionIds = abortedActionIds
    }
    var isValid: Bool {
        [blockedActionIds, abortedActionIds].allSatisfy {
            $0.count <= 10_000 && Set($0).count == $0.count && $0.allSatisfy(approvalIdentityIsValid)
        }
    }
}

public struct BotApprovalPolicyReceipt: Codable, Equatable, Sendable {
    public let id: String
    public let clientRequestId: String
    public let inputHash: String
    public let hostId: String
    public let botId: String
    public let ownerId: String
    public let previous: BotApprovalPolicy
    public let policy: BotApprovalPolicy
    public let revocationEffects: BotApprovalPolicyRevocationEffects
    public let createdAt: Int64
    public init(id: String, clientRequestId: String, inputHash: String, hostId: String, botId: String,
                ownerId: String, previous: BotApprovalPolicy, policy: BotApprovalPolicy,
                revocationEffects: BotApprovalPolicyRevocationEffects, createdAt: Int64) {
        self.id = id; self.clientRequestId = clientRequestId; self.inputHash = inputHash; self.hostId = hostId
        self.botId = botId; self.ownerId = ownerId; self.previous = previous; self.policy = policy
        self.revocationEffects = revocationEffects; self.createdAt = createdAt
    }
    public var isValid: Bool {
        approvalIdentityIsValid(id) && approvalIdentityIsValid(clientRequestId) &&
        inputHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil && previous.isValid && policy.isValid &&
        previous.hostId == hostId && policy.hostId == hostId && previous.botId == botId && policy.botId == botId &&
        previous.ownerId == ownerId && policy.ownerId == ownerId && previous.revision + 1 == policy.revision &&
        policy.receiptId == id && createdAt >= 0 && policy.updatedAt == createdAt && revocationEffects.isValid
    }
    public func matches(botID: String, input: PatchBotApprovalPolicyInput) -> Bool {
        isValid && botId == botID && hostId == input.expectedHostId && clientRequestId == input.clientRequestId &&
        previous.revision == input.expectedRevision && policy.mode == input.mode &&
        policy.eligibleScopeVersion == input.eligibleScopeVersion &&
        inputHash == approvalPolicyRequestHash(botID: botID, ownerID: previous.ownerId, input: input)
    }
}

extension HostClient {
    public func botApprovalPolicy(botID: String) async throws -> BotApprovalPolicy {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: BotApprovalPolicy = try await request("/v1/bots/\(approvalPathSegment(botID))/approval-policy", timeout: 15, localAttachmentRequest: true)
        guard value.isValid, value.botId == botID else { throw HostClientError.contractMismatch }; return value
    }
    public func botApprovalPolicyReceipt(botID: String, input: PatchBotApprovalPolicyInput) async throws -> BotApprovalPolicyReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard input.isValid else { throw HostClientError.invalidRequest }
        let value: BotApprovalPolicyReceipt = try await request(
            "/v1/bots/\(approvalPathSegment(botID))/approval-policy/receipts/\(approvalPathSegment(input.clientRequestId))",
            timeout: 15, localAttachmentRequest: true)
        guard value.matches(botID: botID, input: input) else { throw HostClientError.contractMismatch }; return value
    }
    /// One exact owner mutation. An uncertain response is reconciled by receipt, never automatically resent.
    public func updateBotApprovalPolicy(botID: String, input: PatchBotApprovalPolicyInput) async throws -> BotApprovalPolicyReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard input.isValid else { throw HostClientError.invalidRequest }
        let value: BotApprovalPolicyReceipt
        do {
            value = try await request("/v1/bots/\(approvalPathSegment(botID))/approval-policy", method: "PATCH", body: input,
                                      timeout: 15, localAttachmentRequest: true)
        } catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.matches(botID: botID, input: input) else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
}

func approvalIdentityIsValid(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 256 && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
}
private func approvalPathSegment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? ""
}
private func approvalPolicyRequestHash(botID: String, ownerID: String, input: PatchBotApprovalPolicyInput) -> String? {
    let value: [String: Any] = ["botId": botID, "ownerId": ownerID, "expectedHostId": input.expectedHostId,
                               "clientRequestId": input.clientRequestId, "expectedRevision": input.expectedRevision,
                               "mode": input.mode.rawValue, "eligibleScopeVersion": input.eligibleScopeVersion]
    guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}
