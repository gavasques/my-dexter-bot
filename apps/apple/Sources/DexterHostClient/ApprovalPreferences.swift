import Foundation
import CryptoKit

public struct ApprovalModeEffects: Codable, Equatable, Sendable {
    public let edits: Bool
    public let commands: Bool
    public let routine: Bool
}
public struct ThreadApprovalPolicy: Codable, Equatable, Sendable {
    public let hostId: String
    public let ownerId: String
    public let botId: String
    public let threadId: String
    public let overrideMode: BotApprovalPolicyMode?
    public let revision: Int
    public let receiptId: String?
    public let updatedAt: Int64
}
public struct EffectiveApprovalPolicy: Codable, Equatable, Sendable {
    public let thread: ThreadApprovalPolicy
    public let bot: BotApprovalPolicy
    public let mode: BotApprovalPolicyMode
    public let source: String
    public let effects: ApprovalModeEffects
    public var isValid: Bool {
        bot.isValid && thread.hostId == bot.hostId && thread.ownerId == bot.ownerId && thread.botId == bot.botId &&
        approvalIdentityIsValid(thread.threadId) && thread.revision >= 0 && thread.updatedAt >= 0 &&
        (thread.receiptId.map(approvalIdentityIsValid) ?? (thread.revision == 0 && thread.overrideMode == nil)) &&
        mode == (thread.overrideMode ?? bot.mode) && source == (thread.overrideMode == nil ? "bot_default" : "chat_override") &&
        effects.edits == (mode != .ask) && effects.commands == (mode == .fullAccess) &&
        effects.routine == (mode == .approveAll || mode == .fullAccess)
    }
}
public struct PatchThreadApprovalPolicyInput: Codable, Equatable, Sendable {
    public let expectedHostId: String
    public let clientRequestId: String
    public let expectedRevision: Int
    public let overrideMode: BotApprovalPolicyMode?
    public init(expectedHostId: String, clientRequestId: String, expectedRevision: Int, overrideMode: BotApprovalPolicyMode?) {
        self.expectedHostId = expectedHostId; self.clientRequestId = clientRequestId
        self.expectedRevision = expectedRevision; self.overrideMode = overrideMode
    }
    // nil is an explicit reset to the bot default, never an omitted key with unknown meaning.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(expectedHostId, forKey: .expectedHostId); try c.encode(clientRequestId, forKey: .clientRequestId)
        try c.encode(expectedRevision, forKey: .expectedRevision)
        if let overrideMode { try c.encode(overrideMode, forKey: .overrideMode) } else { try c.encodeNil(forKey: .overrideMode) }
    }
    private enum Keys: String, CodingKey { case expectedHostId, clientRequestId, expectedRevision, overrideMode }
}
public struct ActionApprovalType: Codable, Equatable, Sendable {
    public let key: String?
    public let eligible: Bool
    public let reason: String
    public let category: String
    public let revision: Int
    public let enabled: Bool
    public init(key: String?, eligible: Bool, reason: String, category: String, revision: Int, enabled: Bool) {
        self.key = key; self.eligible = eligible; self.reason = reason; self.category = category; self.revision = revision; self.enabled = enabled
    }
}
public struct ApprovalTypePreference: Codable, Equatable, Sendable, Identifiable {
    public let key: String
    public var id: String { key }
    public let hostId: String
    public let ownerId: String
    public let botId: String
    public let tool: String
    public let destination: String
    public let grantRevision: Int
    public let authorityEpoch: Int
    public let pinsHash: String
    public let revision: Int
    public let enabled: Bool
    public let receiptId: String
    public let updatedAt: Int64
}
public struct DecideApprovalPreferenceInput: Codable, Equatable, Sendable {
    public let expectedHostId: String
    public let clientRequestId: String
    public let requestHash: String
    public let decision: ApprovalDecision
    public let alwaysAccept: Bool
    public let expectedTypeKey: String?
    public let expectedPreferenceRevision: Int
    public init(hostID: String, clientRequestID: String, action: Action, decision: ApprovalDecision, alwaysAccept: Bool) {
        expectedHostId = hostID; clientRequestId = clientRequestID; requestHash = action.requestHash
        self.decision = decision; self.alwaysAccept = alwaysAccept
        expectedTypeKey = action.approvalType?.key; expectedPreferenceRevision = action.approvalType?.revision ?? 0
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(expectedHostId, forKey: .expectedHostId); try c.encode(clientRequestId, forKey: .clientRequestId)
        try c.encode(requestHash, forKey: .requestHash); try c.encode(decision, forKey: .decision)
        try c.encode(alwaysAccept, forKey: .alwaysAccept); try c.encode(expectedPreferenceRevision, forKey: .expectedPreferenceRevision)
        if let expectedTypeKey { try c.encode(expectedTypeKey, forKey: .expectedTypeKey) } else { try c.encodeNil(forKey: .expectedTypeKey) }
    }
    private enum Keys: String, CodingKey { case expectedHostId, clientRequestId, requestHash, decision, alwaysAccept, expectedTypeKey, expectedPreferenceRevision }
}
public struct RevokeApprovalTypeInput: Codable, Equatable, Sendable {
    public let expectedHostId: String
    public let clientRequestId: String
    public let expectedRevision: Int
    public init(expectedHostId: String, clientRequestId: String, expectedRevision: Int) {
        self.expectedHostId = expectedHostId; self.clientRequestId = clientRequestId; self.expectedRevision = expectedRevision
    }
}
public struct ApprovalPreferenceReceipt: Codable, Equatable, Sendable {
    public let id: String
    public let clientRequestId: String
    public let inputHash: String
    public let hostId: String
    public let ownerId: String
    public let botId: String
    public let kind: String
    public let targetId: String
    public let input: JSONValue
    public let previous: JSONValue
    public let state: JSONValue
    public let createdAt: Int64
    public let revocationEffects: BotApprovalPolicyRevocationEffects
    public func matches<Input: Encodable>(botID: String, ownerID: String, kind: String, targetID: String, input: Input) -> Bool {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(input), let expected = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let fields) = expected, fields["expectedHostId"] == .string(hostId), fields["clientRequestId"] == .string(clientRequestId),
              self.input == expected, self.botId == botID, self.ownerId == ownerID, self.kind == kind, self.targetId == targetID,
              approvalIdentityIsValid(id), createdAt >= 0, revocationEffects.isValid else { return false }
        let value: JSONValue = .object(["hostId": .string(hostId), "ownerId": .string(ownerId), "botId": .string(botId),
                                       "kind": .string(kind), "targetId": .string(targetId), "input": expected])
        guard let bytes = try? encoder.encode(value) else { return false }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == inputHash
    }
}
public struct ApprovalPreferenceDecisionResult: Codable, Equatable, Sendable {
    public let receipt: ApprovalPreferenceReceipt
    public let action: Action
}
private struct ApprovalTypesEnvelope: Decodable { let items: [ApprovalTypePreference] }
private func preferencePath(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? ""
}
extension HostClient {
    public func effectiveApprovalPolicy(threadID: String) async throws -> EffectiveApprovalPolicy {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let result: EffectiveApprovalPolicy = try await request("/v1/threads/\(preferencePath(threadID))/approval-policy", localAttachmentRequest: true)
        guard result.isValid, result.thread.threadId == threadID else { throw HostClientError.contractMismatch }; return result
    }
    public func approvalPreferenceReceipt<Input: Encodable & Sendable>(botID: String, ownerID: String, kind: String, targetID: String,
        clientRequestID: String, input: Input) async throws -> ApprovalPreferenceReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let receipt: ApprovalPreferenceReceipt = try await request("/v1/bots/\(preferencePath(botID))/approval-preferences/receipts/\(preferencePath(clientRequestID))", localAttachmentRequest: true)
        guard receipt.clientRequestId == clientRequestID, receipt.matches(botID: botID, ownerID: ownerID, kind: kind, targetID: targetID, input: input)
        else { throw HostClientError.contractMismatch }; return receipt
    }
    public func updateThreadApprovalPolicy(botID: String, ownerID: String, threadID: String, input: PatchThreadApprovalPolicyInput) async throws -> ApprovalPreferenceReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let receipt: ApprovalPreferenceReceipt = try await preferenceMutation("/v1/threads/\(preferencePath(threadID))/approval-policy", method: "PATCH", input: input)
        guard receipt.matches(botID: botID, ownerID: ownerID, kind: "chat_mode", targetID: threadID, input: input) else { throw HostClientError.mutationOutcomeUnknown }; return receipt
    }
    public func decideApprovalPreference(action: Action, ownerID: String, input: DecideApprovalPreferenceInput) async throws -> ApprovalPreferenceDecisionResult {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let current = try await getAction(id: action.id)
        guard current.request == action.request, current.requestHash == input.requestHash,
              current.state != .awaitingApproval || !input.alwaysAccept || current.approvalType?.eligible == true && current.approvalType?.key == input.expectedTypeKey && current.approvalType?.revision == input.expectedPreferenceRevision
        else { throw HostClientError.conflict }
        let result: ApprovalPreferenceDecisionResult = try await preferenceMutation("/v1/actions/\(preferencePath(action.id))/decision-preference", method: "POST", input: input)
        guard result.action.request == action.request, result.action.requestHash == action.requestHash,
              result.receipt.matches(botID: action.request.botId, ownerID: ownerID, kind: "decision", targetID: action.id, input: input)
        else { throw HostClientError.mutationOutcomeUnknown }; return result
    }
    public func approvalTypes(botID: String) async throws -> [ApprovalTypePreference] {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let result: ApprovalTypesEnvelope = try await request("/v1/bots/\(preferencePath(botID))/approval-types", localAttachmentRequest: true)
        guard result.items.allSatisfy({ $0.botId == botID }) else { throw HostClientError.contractMismatch }; return result.items
    }
    public func revokeApprovalType(botID: String, ownerID: String, key: String, input: RevokeApprovalTypeInput) async throws -> ApprovalPreferenceReceipt {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let receipt: ApprovalPreferenceReceipt = try await preferenceMutation("/v1/bots/\(preferencePath(botID))/approval-types/\(preferencePath(key))", method: "PATCH", input: input)
        guard receipt.matches(botID: botID, ownerID: ownerID, kind: "type_revoke", targetID: key, input: input) else { throw HostClientError.mutationOutcomeUnknown }; return receipt
    }
    private func preferenceMutation<Input: Encodable & Sendable, Output: Decodable & Sendable>(_ path: String, method: String, input: Input) async throws -> Output {
        do { return try await request(path, method: method, body: input, timeout: 15, localAttachmentRequest: true) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
    }
}
