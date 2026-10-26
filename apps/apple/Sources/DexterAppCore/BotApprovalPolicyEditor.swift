#if os(macOS)
import DexterHostClient
import Foundation
import Observation

public struct BotApprovalPolicyPendingMutation: Equatable, Sendable {
    public let input: PatchBotApprovalPolicyInput
    public let previous: BotApprovalPolicy
    public let hostAddress: String
    var key: String { "\(hostAddress)\u{1F}\(previous.hostId)\u{1F}\(previous.botId)\u{1F}\(previous.ownerId)" }
}

/// Captured by a human's Save gesture and checked again when its confirmation is accepted.
public struct BotApprovalPolicyConfirmation: Equatable, Sendable {
    public let request: BotApprovalPolicyPendingMutation
    public let hostScope: UUID
}

/// A separate owner-policy coordinator. Profile saves and bot/team selection do not alter its authority.
@MainActor @Observable public final class BotApprovalPolicyEditor {
    public enum Notice: Equatable, Sendable {
        case unavailable, loadFailed, hostChanged, conflict, saveUnknown, receiptMissing, saved, savedRefreshFailed, rejected
    }
    public let botID: String
    public let ownerID: String
    public let session: SettingsEditorSession
    public var hostScope: UUID { session.hostScope }
    public var hostAddress: String { session.hostAddress }
    public private(set) var baseline: BotApprovalPolicy?
    public private(set) var lastReceipt: BotApprovalPolicyReceipt?
    public private(set) var pending: BotApprovalPolicyPendingMutation?
    public private(set) var busy = false
    public private(set) var notice: Notice?
    public private(set) var requiresReload = false
    public var mode: BotApprovalPolicyMode = .ask
    @ObservationIgnored private weak var model: DexterAppModel?
    @ObservationIgnored private var active = true
    @ObservationIgnored private var generation = UUID()

    public init(bot: Bot, model: DexterAppModel, session: SettingsEditorSession? = nil) {
        botID = bot.id; ownerID = bot.ownerId; self.model = model
        self.session = session ?? SettingsEditorSession(target: .bot(bot), model: model)
        if let hostID = model.approvalPolicyHostID {
            pending = model.pendingBotApprovalPolicyMutations.values.first {
                $0.hostAddress == hostAddress && $0.previous.hostId == hostID && $0.previous.botId == botID && $0.previous.ownerId == ownerID
            }
        }
    }
    public var scopeMatches: Bool {
        guard let model else { return false }
        return active && session.matches(botID: botID, ownerID: ownerID, in: model) &&
            model.bots.contains(where: { $0.id == botID && $0.ownerId == ownerID }) &&
            (baseline.map { $0.hostId == model.approvalPolicyHostID } ?? true) &&
            (pending.map { $0.previous.hostId == model.approvalPolicyHostID } ?? true)
    }
    public var dirty: Bool { baseline.map { mode != $0.mode } ?? false }
    public var canEdit: Bool { scopeMatches && baseline != nil && pending == nil && !busy && !requiresReload }
    public var canSave: Bool { canEdit && dirty }
    public var lastReceiptEffects: AccessMutationEffectSummary? { lastReceipt.map { AccessMutationEffectSummary($0.revocationEffects) } }
    public var canRetryExactRequest: Bool { scopeMatches && pending != nil && !busy && notice == .receiptMissing }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }

    public func close() { active = false; generation = UUID(); busy = false }
    public func invalidate() { close(); requiresReload = true; notice = .hostChanged }

    public func load() async {
        guard scopeMatches, !busy, let model else { return }
        if pending != nil { await reconcile(); return }
        busy = true; notice = nil; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let value = try await model.loadBotApprovalPolicy(botID: botID, ownerID: ownerID, session: session)
            guard accepts(token) else { return }
            baseline = value; mode = value.mode; requiresReload = false
        } catch {
            guard accepts(token) else { return }
            baseline = nil; requiresReload = true
            notice = [HostClientError.notFound, .notReady, .forbidden].contains(error as? HostClientError ?? .hostFailure) ? .unavailable : .loadFailed
        }
        guard accepts(token) else { return }; busy = false
    }

    /// Read-only update, preserving the human's mode draft. A stale confirmation is refused by its baseline snapshot.
    public func refreshPreservingDraft() async {
        guard scopeMatches, !busy, pending == nil, let model else { return }
        let draft = mode, hadDraft = dirty, token = generation
        busy = true
        defer { if token == generation { busy = false } }
        do {
            let value = try await model.loadBotApprovalPolicy(botID: botID, ownerID: ownerID, session: session)
            guard accepts(token) else { return }
            baseline = value; mode = hadDraft ? draft : value.mode; requiresReload = false
        } catch {
            guard accepts(token) else { return }
            requiresReload = true; notice = .loadFailed
        }
    }

    public func prepareHumanSave() -> BotApprovalPolicyConfirmation? {
        guard canSave, let baseline else { return nil }
        let input = PatchBotApprovalPolicyInput(expectedHostId: baseline.hostId, clientRequestId: UUID().uuidString.lowercased(),
                                               expectedRevision: baseline.revision, mode: mode, eligibleScopeVersion: baseline.eligibleScopeVersion)
        return BotApprovalPolicyConfirmation(request: BotApprovalPolicyPendingMutation(input: input, previous: baseline,
                                                                                       hostAddress: hostAddress), hostScope: hostScope)
    }

    public func saveHumanChoice(_ confirmation: BotApprovalPolicyConfirmation) async {
        guard canSave, confirmation.hostScope == hostScope, confirmation.request.previous == baseline,
              confirmation.request.input.mode == mode, confirmation.request.hostAddress == hostAddress,
              confirmation.request.previous.botId == botID, confirmation.request.previous.ownerId == ownerID,
              let model else { return }
        pending = confirmation.request
        model.pendingBotApprovalPolicyMutations[confirmation.request.key] = confirmation.request
        await sendExactPending()
    }

    public func retryExactRequest() async {
        guard canRetryExactRequest else { return }
        await sendExactPending()
    }

    private func acceptReceipt(_ receipt: BotApprovalPolicyReceipt, request: BotApprovalPolicyPendingMutation) throws {
        guard receipt.previous == request.previous, receipt.ownerId == ownerID,
              receipt.matches(botID: botID, input: request.input) else { throw HostClientError.contractMismatch }
        model?.pendingBotApprovalPolicyMutations.removeValue(forKey: request.key)
        lastReceipt = receipt; baseline = receipt.policy; mode = receipt.policy.mode
        pending = nil; requiresReload = false; notice = .saved
    }

    private func refreshConfirmedPolicy(_ token: UUID, model: DexterAppModel) async {
        do {
            let value = try await model.loadBotApprovalPolicy(botID: botID, ownerID: ownerID, session: session)
            guard accepts(token) else { return }
            guard value.revision >= (baseline?.revision ?? 0) else { throw HostClientError.contractMismatch }
            baseline = value; mode = value.mode
        } catch {
            guard accepts(token) else { return }
            requiresReload = true; notice = .savedRefreshFailed
        }
    }

    private func sendExactPending() async {
        guard scopeMatches, !busy, let pending, let model else { return }
        busy = true; notice = nil; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let receipt = try await model.updateBotApprovalPolicy(botID: botID, ownerID: ownerID, input: pending.input, session: session)
            guard accepts(token) else { return }
            try acceptReceipt(receipt, request: pending)
            await refreshConfirmedPolicy(token, model: model)
        } catch {
            guard accepts(token) else { return }
            requiresReload = true
            switch error as? HostClientError {
            case .invalidRequest, .forbidden, .notFound, .notReady:
                model.pendingBotApprovalPolicyMutations.removeValue(forKey: pending.key)
                self.pending = nil; notice = .rejected
            case .conflict:
                // Replay is checked before CAS by the host. A definitive 409 has not accepted this request.
                model.pendingBotApprovalPolicyMutations.removeValue(forKey: pending.key)
                self.pending = nil; notice = .conflict
            default: notice = .saveUnknown
            }
        }
        guard accepts(token) else { return }; busy = false
    }

    /// Reads receipt first; a missing receipt only enables an explicit replay of the original request.
    public func reconcile() async {
        guard scopeMatches, !busy, let pending, let model else { return }
        busy = true; notice = nil; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let receipt = try await model.reconcileBotApprovalPolicy(botID: botID, ownerID: ownerID, input: pending.input, session: session)
            guard accepts(token) else { return }
            try acceptReceipt(receipt, request: pending)
            await refreshConfirmedPolicy(token, model: model)
        } catch {
            guard accepts(token) else { return }
            requiresReload = true
            if error as? HostClientError == .notFound {
                do {
                    let value = try await model.loadBotApprovalPolicy(botID: botID, ownerID: ownerID, session: session)
                    guard accepts(token) else { return }
                    baseline = value; mode = value.mode; notice = .receiptMissing
                } catch {
                    guard accepts(token) else { return }; notice = .loadFailed
                }
            } else { notice = .saveUnknown }
        }
        guard accepts(token) else { return }; busy = false
    }
}
#endif
