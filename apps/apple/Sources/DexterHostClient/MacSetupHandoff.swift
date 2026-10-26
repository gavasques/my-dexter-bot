import Foundation

/// Public, value-free receipt of an exact-owner `dexter.harness.mac.setup.request`
/// (`packages/contracts/src/mac-setup-handoff.ts`). It only lets the owner's own app show the read-only computer-access
/// panel for the same host, bot and thread. It carries no device, path, helper, permission or session value and is never
/// proof that a page opened, setup finished or the Mac is ready. `configurationRevision` is an opaque host CAS token.
public struct MacSetupHandoff: Codable, Equatable, Sendable {
    public static let ttlMilliseconds: Int64 = 300_000
    public let kind: String
    public let target: String
    public let hostId: String
    public let botId: String
    public let threadId: String
    public let actionId: String
    public let requestHash: String
    public let configurationRevision: String
    public let expiresAt: Int64
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind, target, hostId, botId, threadId, actionId, requestHash, configurationRevision, expiresAt
    }
    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    public init(from decoder: any Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        guard Set(all.allKeys.map(\.stringValue)) == Set(CodingKeys.allCases.map(\.rawValue)) else { throw HostClientError.contractMismatch }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        target = try values.decode(String.self, forKey: .target)
        hostId = try values.decode(String.self, forKey: .hostId)
        botId = try values.decode(String.self, forKey: .botId)
        threadId = try values.decode(String.self, forKey: .threadId)
        actionId = try values.decode(String.self, forKey: .actionId)
        requestHash = try values.decode(String.self, forKey: .requestHash)
        configurationRevision = try values.decode(String.self, forKey: .configurationRevision)
        expiresAt = try values.decode(Int64.self, forKey: .expiresAt)
        guard kind == "mac_setup_handoff", target == "computer_access",
              [hostId, botId, threadId, actionId].allSatisfy({ $0.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil }),
              McpAuthorizationHandoff.validHash(requestHash), McpAuthorizationHandoff.validHash(configurationRevision),
              expiresAt > 0, expiresAt <= 9_007_199_254_740_991 else {
            throw HostClientError.contractMismatch
        }
    }

    /// The model-visible request: exactly `{"expected_revision": <64 lowercase hex>}` on the owner-proposals destination.
    public static func isRequest(_ request: ActionRequest) -> Bool {
        guard request.tool == "dexter.harness.mac.setup.request", request.destination == "dexter-harness-owner-proposals",
              case .object(let input)? = request.arguments["input"], Set(input.keys) == ["expected_revision"],
              case .string(let revision)? = input["expected_revision"] else { return false }
        return McpAuthorizationHandoff.validHash(revision)
    }
}

public extension Action {
    /// A successful exact-owner action, bound to its original normalized request; arbitrary model output is ignored.
    var macSetupHandoff: MacSetupHandoff? {
        guard state == .succeeded, authorization?.source == .exactOwner,
              decidedBy == authorization?.ownerId, decidedBy != nil, MacSetupHandoff.isRequest(request),
              case .object(let input)? = request.arguments["input"], case .string(let revision)? = input["expected_revision"],
              let result, let bytes = try? JSONEncoder().encode(result),
              let handoff = try? JSONDecoder().decode(MacSetupHandoff.self, from: bytes),
              handoff.configurationRevision == revision, handoff.actionId == id, handoff.requestHash == requestHash,
              handoff.botId == request.botId, handoff.threadId == request.threadId,
              updatedAt >= 0, updatedAt <= 9_007_199_254_740_991,
              handoff.expiresAt >= updatedAt, handoff.expiresAt <= updatedAt + MacSetupHandoff.ttlMilliseconds else { return nil }
        return handoff
    }
}
