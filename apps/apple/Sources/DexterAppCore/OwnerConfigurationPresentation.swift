import DexterHostClient
import Foundation

/// UI R1 (MCP3-B / memory4-B): pure facts the bot settings window renders over `OwnerConfigurationEditor`.
/// Display only. Nothing here sends, decides, retries or picks an account; wording stays in the views' catalog.
public enum McpAccountsSelectionMode: String, CaseIterable, Hashable, Sendable {
    /// Exactly one available account.
    case one
    /// Any number of available accounts, including none (this bot loses its MCP tools).
    case some
    /// Every account available at review time, listed one by one: never a wildcard for later accounts.
    case all
}

/// The owner's draft for this bot, started from the host's current snapshot. Tool sets are kept per account even while
/// an account is unticked, so switching modes never loses a choice.
public struct McpAccountsDraft: Equatable, Sendable {
    public var mode: McpAccountsSelectionMode
    public private(set) var included: Set<String>
    public private(set) var tools: [String: Set<String>]

    public init(review: McpInstanceSelectionReview) {
        let available = Set(review.instances.map(\.serverId))
        var tools: [String: Set<String>] = [:]
        for row in review.selected { tools[row.serverId] = Set(row.toolIds) }
        self.tools = tools
        included = Set(review.selected.map(\.serverId)).intersection(available)
        mode = included.count > 1 ? .some : .one
    }

    public func isIncluded(_ serverID: String, in review: McpInstanceSelectionReview) -> Bool {
        mode == .all ? review.instances.contains { $0.serverId == serverID } : included.contains(serverID)
    }
    public func tools(for serverID: String) -> Set<String> { tools[serverID] ?? [] }

    /// `.one` keeps a single account; the others keep their tool choices for later. `.all` has no per-account choice.
    public mutating func include(_ serverID: String, _ on: Bool, in review: McpInstanceSelectionReview) {
        guard mode != .all, review.instances.contains(where: { $0.serverId == serverID }) else { return }
        if mode == .one { included = on ? [serverID] : [] } else if on { included.insert(serverID) } else { included.remove(serverID) }
    }
    public mutating func setMode(_ next: McpAccountsSelectionMode) {
        if next == .one, included.count > 1, let first = included.sorted().first { included = [first] }
        mode = next
    }
    public mutating func setTool(_ toolID: String, _ on: Bool, serverID: String) {
        var set = tools[serverID] ?? []
        if on { set.insert(toolID) } else { set.remove(toolID) }
        tools[serverID] = set
    }
    /// Draft-only convenience; it approves nothing.
    public mutating func setTools(_ toolIDs: Set<String>, serverID: String) { tools[serverID] = toolIDs }

    public enum Issue: Equatable, Sendable {
        case noChange
        case chooseOneAccount
        case chooseTools([String])
        /// The host refuses "all connected" while an account cannot be listed; nothing is sent.
        case allNeedsEveryAccount([String])
        case noAccounts
    }

    /// The exact accounts and tools this draft asks for, sorted the way the host's strict schema wants them.
    public func choices(in review: McpInstanceSelectionReview) -> [McpInstanceSelectionChoice] {
        review.instances.map(\.serverId).sorted().filter { isIncluded($0, in: review) }
            .map { McpInstanceSelectionChoice(serverID: $0, toolIDs: tools(for: $0).sorted()) }
    }
    public func issue(in review: McpInstanceSelectionReview) -> Issue? {
        let chosen = choices(in: review)
        switch mode {
        case .all:
            if review.instances.isEmpty { return .noAccounts }
            if !review.unavailableInstances.isEmpty { return .allNeedsEveryAccount(review.unavailableInstances.map(\.serverId).sorted()) }
        case .one:
            if chosen.count != 1 { return .chooseOneAccount }
        case .some:
            break
        }
        let empty = chosen.filter { $0.toolIds.isEmpty }.map(\.serverId)
        if !empty.isEmpty { return .chooseTools(empty) }
        let current = Dictionary(uniqueKeysWithValues: review.selected.map { ($0.serverId, Set($0.toolIds)) })
        let desired = Dictionary(uniqueKeysWithValues: chosen.map { ($0.serverId, Set($0.toolIds)) })
        // "All connected" is always a deliberate new snapshot, even when its accounts equal the current one.
        if mode != .all && current == desired { return .noChange }
        return nil
    }
    /// Read-only input for `OwnerConfigurationEditor.plan`; nil while the draft has an issue.
    public func input(for review: McpInstanceSelectionReview) -> McpInstanceSelectionInput? {
        guard issue(in: review) == nil else { return nil }
        return McpInstanceSelectionInput(review: review, mode: mode == .all ? .allConnected : .explicit, instances: choices(in: review))
    }
}

/// One account in the review of the host's materialized plan against the snapshot it was planned from.
public struct McpAccountChange: Equatable, Identifiable, Sendable {
    public enum Kind: Equatable, Sendable { case added, removed, changed, unchanged }
    public var id: String { serverID }
    public let serverID: String
    public let connectionID: String?
    public let kind: Kind
    public let added: [String]
    public let removed: [String]
    public let kept: [String]
}

public enum McpAccountsPresentation {
    /// Selected now but not plannable (catalog or generation missing): any applied change removes this bot's tools there.
    public static func selectedButUnavailable(_ review: McpInstanceSelectionReview) -> [String] {
        let available = Set(review.instances.map(\.serverId))
        return review.selected.map(\.serverId).filter { !available.contains($0) }.sorted()
    }
    public static func allConnectedAvailable(_ review: McpInstanceSelectionReview) -> Bool {
        !review.instances.isEmpty && review.unavailableInstances.isEmpty
    }
    /// The exact difference the host would apply: plan targets versus the selected snapshot of the same review.
    public static func changes(review: McpInstanceSelectionReview, plan: McpInstanceSelectionPlan) -> [McpAccountChange] {
        let current = Dictionary(uniqueKeysWithValues: review.selected.map { ($0.serverId, ($0.connectionId, Set($0.toolIds))) })
        let desired = Dictionary(uniqueKeysWithValues: plan.targets.map { ($0.serverId, ($0.connectionId, Set($0.toolIds))) })
        return Set(current.keys).union(desired.keys).sorted().map { id in
            let before = current[id]?.1 ?? [], after = desired[id]?.1 ?? []
            let kind: McpAccountChange.Kind = current[id] == nil ? .added : desired[id] == nil ? .removed : before == after ? .unchanged : .changed
            return McpAccountChange(serverID: id, connectionID: desired[id]?.0 ?? current[id]?.0, kind: kind,
                                    added: after.subtracting(before).sorted(), removed: before.subtracting(after).sorted(),
                                    kept: before.intersection(after).sorted())
        }
    }
    /// The plan returned by the host is what is reviewed and sent; a different snapshot means "review again".
    public static func planMatchesReview(_ plan: McpInstanceSelectionPlan, _ review: McpInstanceSelectionReview) -> Bool {
        plan.inventoryPin == review.inventoryPin && plan.selectionPin == review.selectionPin && plan.expectedRevision == review.revision
    }

    public enum Outcome: Equatable, Sendable {
        /// Effect receipt completed; `matchesNow` is the host's current comparison, not a repair claim.
        case applied(matchesNow: Bool)
        case partial(code: String?)
        case pending
        /// No effect receipt yet: literal absence, never a reason to resend.
        case noEffectReceipt
    }
    public static func outcome(_ observation: McpInstanceSelectionReceiptObservation) -> Outcome {
        guard let selection = observation.selection else { return .noEffectReceipt }
        switch selection.receipt.phase {
        case "completed": return .applied(matchesNow: selection.current == "matches")
        case "partial": return .partial(code: selection.receipt.code)
        default: return .pending
        }
    }
}

/// Pure window check for rendering. `OwnerConfigurationEditor.scopeMatches` goes through `SettingsEditorSession.isCurrent`,
/// which retires the session when read; views read this instead and latch from hooks/handlers.
@MainActor public enum OwnerConfigurationWindowFacts {
    public static func isCurrent(session: SettingsEditorSession, model: DexterAppModel, botID: String, ownerID: String, editorInvalidated: Bool) -> Bool {
        guard !editorInvalidated, !session.closed, !session.invalidated, model.canEditBotProfiles,
              session.hostScope == model.nativeComposerScope, session.hostAddress == model.hostAddress,
              let hostID = session.effectiveHostID, hostID == model.approvalPolicyHostID else { return false }
        return model.bots.contains { $0.id == botID && $0.ownerId == ownerID }
    }
}

/// The stage of the window's single owner proposal, from the technical editor's literal values.
public enum OwnerProposalStage: Equatable, Sendable {
    case none
    /// Reviewed and kept locally; nothing was sent.
    case prepared
    case sending
    case awaitingDecision
    /// Decided Allow; the host is still applying (action ready/running).
    case applying
    /// The host says the outcome is unknown (dispatcher literal).
    case hostUnknown
    /// The send or decision was not acknowledged and the original request reads nothing yet.
    case notConfirmed
    case succeeded
    case denied
    case blocked
    case retired

    public static func from(state: OwnerConfigurationEditor.State, action: ActionState?, mutationSent: Bool) -> OwnerProposalStage {
        switch state {
        case .idle: return .none
        case .prepared: return .prepared
        case .submitting: return .sending
        case .awaitingApproval: return .awaitingDecision
        case .decided: return .succeeded
        case .rejected: return action == .blocked ? .blocked : .denied
        case .invalidated: return .retired
        case .unknown:
            switch action {
            case .ready?, .running?: return .applying
            case .unknown?: return .hostUnknown
            case .awaitingApproval?: return .awaitingDecision
            case .succeeded?: return .succeeded
            case .denied?: return .denied
            case .blocked?: return .blocked
            case nil: return mutationSent ? .notConfirmed : .prepared
            }
        }
    }
    /// Only reading the original request can change these; a new review waits.
    public var needsCheck: Bool { [.sending, .applying, .hostUnknown, .notConfirmed].contains(self) }
    public var isTerminal: Bool { [.succeeded, .denied, .blocked].contains(self) }
    /// Closing the window loses the ability to follow this request here (no disk journal).
    public var isOpen: Bool { [.prepared, .sending, .awaitingDecision, .applying, .hostUnknown, .notConfirmed].contains(self) }
}

public enum MemorySuggestionsPresentation {
    public enum Availability: Equatable, Sendable { case literalExcerpt, injected, unconfigured }
    public enum Policy: Equatable, Sendable { case off, on, onWithoutEffect }
    public static func availability(_ status: MemoryRoutinePolicyStatus) -> Availability {
        switch status.extractor { case "literal_excerpt": .literalExcerpt; case "injected": .injected; default: .unconfigured }
    }
    public static func policy(_ status: MemoryRoutinePolicyStatus) -> Policy {
        !status.policy.enabled ? .off : status.effectiveEnabled ? .on : .onWithoutEffect
    }
    /// Duplicate maintenance needs an effective policy that allows it; the host refuses the preview otherwise.
    public static func maintenanceAvailable(_ status: MemoryRoutinePolicyStatus) -> Bool {
        status.effectiveEnabled && status.policy.maintenanceEnabled
    }

    public enum Candidate: Equatable, Sendable {
        /// Literal text waiting for the owner; nothing is saved.
        case suggested
        /// A proposal exists (this or another window); read it, never propose again.
        case proposed
        case saved
        case withdrawn
        case conflict
        case unknown
        case extracting
    }
    /// Only capture jobs with literal text are listed; empty/invalid results stay out of the owner's way.
    public static func candidate(_ job: MemoryRoutineJob) -> Candidate? {
        guard job.kind == "capture", job.note?.isEmpty == false || job.state == "extracting" else { return nil }
        switch job.state {
        case "candidate": return job.actionId == nil ? .suggested : .proposed
        case "proposed": return .proposed
        case "committed": return .saved
        case "withdrawn": return .withdrawn
        case "conflict": return .conflict
        case "unknown": return .unknown
        case "extracting": return .extracting
        default: return nil
        }
    }
    public static func listed(_ jobs: [MemoryRoutineJob]) -> [MemoryRoutineJob] {
        jobs.filter { candidate($0) != nil }.sorted { $0.createdAt > $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id) }
    }
}
