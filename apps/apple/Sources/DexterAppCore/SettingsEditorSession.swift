import DexterHostClient
import Foundation
import Observation

/// One window's original target. Retain this object and its snapshots until the owner closes or explicitly switches.
/// IDs/revisions do not identify a base: connection generation, URL and effective host identity are all required.
@MainActor @Observable public final class SettingsEditorSession {
    public enum Target: Equatable, Sendable {
        case bot(Bot)
        case team(Team)
        case newTeam
        case newGroup
    }
    public enum OperationKind: Sendable { case read, mutation }
    public let id: UUID
    public let target: Target
    public let hostScope: UUID
    public let hostAddress: String
    public let effectiveHostID: String?
    public private(set) var invalidated = false
    public private(set) var closed = false

    public init(target: Target, model: DexterAppModel, id: UUID = UUID(), hostScope: UUID? = nil, hostAddress: String? = nil) {
        self.id = id; self.target = target
        self.hostScope = hostScope ?? model.nativeComposerScope
        self.hostAddress = hostAddress ?? model.hostAddress
        // Never infer identity for a stale router target from the model's new base.
        effectiveHostID = self.hostScope == model.nativeComposerScope && self.hostAddress == model.hostAddress
            ? model.approvalPolicyHostID : nil
    }
    public var bot: Bot? { if case .bot(let bot) = target { return bot }; return nil }
    public var team: Team? { if case .team(let team) = target { return team }; return nil }
    public var botID: String? { bot?.id }
    public var teamID: String? { team?.id }

    /// A mismatch permanently retires the session. Returning to the old URL cannot revive a window or its drafts.
    public func isCurrent(in model: DexterAppModel) -> Bool {
        guard !closed, !invalidated else { return false }
        guard model.canEditBotProfiles, hostScope == model.nativeComposerScope, hostAddress == model.hostAddress,
              let effectiveHostID, effectiveHostID == model.approvalPolicyHostID else {
            invalidated = true; return false
        }
        switch target {
        case .bot(let bot):
            guard model.bots.contains(where: { $0.id == bot.id && $0.ownerId == bot.ownerId }) else { invalidated = true; return false }
        case .team(let team):
            guard model.canEditTeams, model.teams.contains(where: { $0.id == team.id && $0.ownerId == team.ownerId }) else { invalidated = true; return false }
        case .newGroup:
            guard model.canEditBotProfiles else { invalidated = true; return false }
        case .newTeam:
            guard model.canEditTeams else { invalidated = true; return false }
        }
        return true
    }
    public func matches(botID: String, ownerID: String, in model: DexterAppModel) -> Bool {
        bot?.id == botID && bot?.ownerId == ownerID && isCurrent(in: model)
    }
    public func close() { closed = true }

    /// Use once per query/mutation (including receipt, restore and resources), never around a multi-request loop.
    /// The model captures its current client before awaiting and rejects callbacks when the session has retired.
    public func perform<Value: Sendable>(in model: DexterAppModel, kind: OperationKind = .read,
        operation: @MainActor (HostClient) async throws -> Value) async throws -> Value {
        try await model.performSettingsOperation(session: self, kind: kind, operation: operation)
    }
}

/// Presentation facts, not text or rollback evidence. Zero stopped effects require no partial-effect warning.
public struct AccessMutationEffectSummary: Equatable, Sendable {
    public let blockedCount: Int
    public let stopRequestedCount: Int
    public var shouldExplainPossiblePartialEffects: Bool { stopRequestedCount > 0 }
    public init(_ effects: BotApprovalPolicyRevocationEffects) {
        blockedCount = effects.blockedActionIds.count; stopRequestedCount = effects.abortedActionIds.count
    }
}
