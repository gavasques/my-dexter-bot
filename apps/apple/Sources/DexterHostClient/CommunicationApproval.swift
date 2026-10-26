import Foundation

/// Exact, whole-phrase replies only. Display text and model output never grant authority.
public enum CommunicationApprovalText {
    public static func decision(for text: String) -> ApprovalDecision? {
        guard text.utf16.count <= 80 else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // A question ("Pode aplicar?") asks about the operation; it does not authorize it.
        let phrase = trimmed.replacingOccurrences(of: "[.!]+$", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        switch phrase {
        case "sim", "yes", "pode fazer", "pode aplicar", "autorizo": return .allow
        case "não", "nao", "no", "não pode", "nao pode": return .deny
        default: return nil
        }
    }
}

/// Only the three communication flags may be changed by this owner-approved proposal.
public struct BotCommunicationChanges: Codable, Equatable, Sendable {
    public let canSeeBots: Bool?
    public let canSendActions: Bool?
    public let canReceiveOrders: Bool?

    public var isEmpty: Bool { canSeeBots == nil && canSendActions == nil && canReceiveOrders == nil }

    public func matches(_ bot: Bot) -> Bool {
        (canSeeBots.map { bot.canSeeBots == $0 } ?? true)
            && (canSendActions.map { bot.canSendActions == $0 } ?? true)
            && (canReceiveOrders.map { bot.canReceiveOrders == $0 } ?? true)
    }
}

/// Parsed only from the action persisted by the host, never from conversational prose.
public struct BotCommunicationProposal: Equatable, Sendable {
    public static let tool = "dexter.harness.bots.communication.update"
    public static let destination = "dexter-harness-owner-proposals"
    public let expectedRevision: Int
    public let hostID: String
    public let turnID: String
    public let changes: BotCommunicationChanges

    public init?(action: Action) {
        guard action.request.tool == Self.tool, action.request.destination == Self.destination,
              Set(action.request.arguments.keys) == ["input", "pin"],
              case .object(let input) = action.request.arguments["input"],
              case .object(let pin) = action.request.arguments["pin"],
              Set(input.keys).isSubset(of: ["expectedRevision", "canSeeBots", "canSendActions", "canReceiveOrders"]),
              Set(pin.keys) == ["revision", "hostId", "turnId"],
              case .integer(let revision) = input["expectedRevision"], revision >= 0, revision < Int.max,
              case .integer(let pinnedRevision) = pin["revision"], pinnedRevision == revision,
              case .string(let hostID) = pin["hostId"], !hostID.isEmpty,
              case .string(let turnID) = pin["turnId"], !turnID.isEmpty else { return nil }
        func flag(_ key: String) -> Bool? {
            guard case .bool(let value) = input[key] else { return nil }
            return value
        }
        for key in ["canSeeBots", "canSendActions", "canReceiveOrders"] where input[key] != nil {
            guard case .bool = input[key] else { return nil }
        }
        let changes = BotCommunicationChanges(canSeeBots: flag("canSeeBots"), canSendActions: flag("canSendActions"), canReceiveOrders: flag("canReceiveOrders"))
        guard !changes.isEmpty else { return nil }
        self.expectedRevision = Int(revision); self.hostID = hostID; self.turnID = turnID; self.changes = changes
    }
}

public struct CommunicationConfirmationInput: Codable, Equatable, Sendable {
    public let actionId: String
    public let requestHash: String
    public let clientRequestId: String
    public let text: String

    public init(actionId: String, requestHash: String, clientRequestId: String, text: String) {
        self.actionId = actionId; self.requestHash = requestHash; self.clientRequestId = clientRequestId; self.text = text
    }
}

public struct CommunicationConfirmationReceipt: Codable, Equatable, Sendable {
    public let actionId: String
    public let requestHash: String
    public let clientRequestId: String
    public let decision: ApprovalDecision
    public let previousRevision: Int
    public let revision: Int
    public let changes: BotCommunicationChanges
    public let applied: Bool
    public let appliesNextTurn: Bool
}

public struct CommunicationConfirmationResponse: Codable, Equatable, Sendable {
    public let action: Action
    public let bot: Bot
    public let messages: [Message]
    public let receipt: CommunicationConfirmationReceipt
}
