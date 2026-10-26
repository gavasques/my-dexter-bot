import DexterHostClient
import Foundation

/// Correlation for the notice from the latest stop, separate from the accumulated security deny/correlation sets.
/// Origin is canonical; the action snapshot is the clicked action (or one from this stop), never a historical search.
public struct TurnControlStopContext: Equatable, Sendable {
    public let originTurnID: String
    public let threadID: String
    public let botID: String
    public let action: Action?
    public let actionIDs: Set<String>
    public let requestedAt: Date
    public let hadRunningEffects: Bool
    public init(origin: Turn, actions: [Action], representative: Action? = nil, requestedAt: Date) {
        originTurnID = origin.id; threadID = origin.threadId; botID = origin.botId
        actionIDs = Set(actions.map(\.id))
        action = representative.flatMap { candidate in actions.first(where: { $0.id == candidate.id }) }
            ?? actions.max(by: { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) })
        self.requestedAt = requestedAt
        hadRunningEffects = actions.contains { $0.state == .running }
    }
}
