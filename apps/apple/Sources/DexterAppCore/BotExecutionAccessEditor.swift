#if os(macOS)
import DexterHostClient
import Foundation
import Observation

public struct BotExecutionAccessPendingMutation: Equatable, Sendable {
    public let input: PatchBotExecutionAccessInput
    public let previous: BotExecutionAccess
    public let hostAddress: String
    var key: String { "\(hostAddress)\u{1F}\(previous.hostId)\u{1F}\(previous.botId)\u{1F}\(previous.ownerId)" }
}

/// Captured by a human's Save gesture and checked again when its confirmation is accepted.
public struct BotExecutionAccessConfirmation: Equatable, Sendable {
    public let request: BotExecutionAccessPendingMutation
    public let hostScope: UUID
}

/// A separate owner-policy coordinator. Profile saves and bot/team selection do not alter its authority.
@MainActor @Observable public final class BotExecutionAccessEditor {
    public enum Notice: Equatable, Sendable {
        case unavailable, loadFailed, hostChanged, conflict, saveUnknown, receiptMissing, saved, savedRefreshFailed, rejected
    }
    public let botID: String
    public let ownerID: String
    public let session: SettingsEditorSession
    public var hostScope: UUID { session.hostScope }
    public var hostAddress: String { session.hostAddress }
    public private(set) var baseline: BotExecutionAccess?
    public private(set) var lastReceipt: BotExecutionAccessReceipt?
    public private(set) var pending: BotExecutionAccessPendingMutation?
    public private(set) var busy = false
    public private(set) var notice: Notice?
    public private(set) var requiresReload = false
    @ObservationIgnored private weak var model: DexterAppModel?
    @ObservationIgnored private var active = true
    @ObservationIgnored private var generation = UUID()

    public init(bot: Bot, model: DexterAppModel, session: SettingsEditorSession? = nil) {
        botID = bot.id; ownerID = bot.ownerId; self.model = model
        self.session = session ?? SettingsEditorSession(target: .bot(bot), model: model)
        if let hostID = model.approvalPolicyHostID {
            pending = model.pendingBotExecutionAccessMutations.values.first {
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
    public var canEdit: Bool { scopeMatches && baseline != nil && pending == nil && !busy && !requiresReload }
    public var canSave: Bool { canEdit }
    public var lastReceiptEffects: AccessMutationEffectSummary? { lastReceipt.map { AccessMutationEffectSummary($0.revocationEffects) } }
    public var canRetryExactRequest: Bool { scopeMatches && pending != nil && !busy && notice == .receiptMissing }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }

    public func close() { active = false; generation = UUID(); busy = false }
    public func invalidate() { close(); requiresReload = true; notice = .hostChanged }

    public enum RefreshReason: Equatable, Sendable { case opened, sectionRequested, localActionChanged, explicitReload }
    public private(set) var lastRefreshReason: RefreshReason?

    public func load() async {
        if pending != nil { await reconcile(); return }
        await refresh(reason: .opened)
    }

    /// One inventory GET on this same editor. Never reapplies grants, resends a PATCH or clears another editor's draft.
    /// A pending uncertain mutation has its separate explicit receipt-reconciliation path.
    public func refresh(reason: RefreshReason) async {
        guard scopeMatches, !busy, pending == nil, let model else { return }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        lastRefreshReason = reason
        do {
            let value = try await model.loadBotExecutionAccess(botID: botID, ownerID: ownerID, session: session)
            guard accepts(token) else { return }
            baseline = value; requiresReload = false; notice = nil
        } catch {
            guard accepts(token) else { return }
            // Keep the last confirmed inventory visible but non-editable on a failed refresh.
            requiresReload = true
            notice = [HostClientError.notFound, .notReady, .forbidden].contains(error as? HostClientError ?? .hostFailure) ? .unavailable : .loadFailed
        }
    }

    public func prepareHumanChange(operation: BotExecutionOperation, enabled: Bool) -> BotExecutionAccessConfirmation? {
        guard canSave, let baseline, let entry = baseline.entries.first(where: { $0.operation == operation }), entry.enabled != enabled else { return nil }
        let input = PatchBotExecutionAccessInput(access: baseline, operation: operation, enabled: enabled,
                                                clientRequestId: UUID().uuidString.lowercased())
        return BotExecutionAccessConfirmation(request: BotExecutionAccessPendingMutation(input: input, previous: baseline,
                                                                                         hostAddress: hostAddress), hostScope: hostScope)
    }
    public func saveHumanChoice(_ confirmation: BotExecutionAccessConfirmation) async {
        guard canSave, confirmation.hostScope == hostScope, confirmation.request.previous == baseline,
              confirmation.request.hostAddress == hostAddress, confirmation.request.previous.botId == botID,
              confirmation.request.previous.ownerId == ownerID, let model else { return }
        pending = confirmation.request
        model.pendingBotExecutionAccessMutations[confirmation.request.key] = confirmation.request
        await sendExactPending()
    }

    public func retryExactRequest() async {
        guard canRetryExactRequest else { return }
        await sendExactPending()
    }

    private func acceptReceipt(_ receipt: BotExecutionAccessReceipt, request: BotExecutionAccessPendingMutation) throws {
        guard receipt.previous == request.previous, receipt.ownerId == ownerID,
              receipt.matches(botID: botID, input: request.input) else { throw HostClientError.contractMismatch }
        model?.pendingBotExecutionAccessMutations.removeValue(forKey: request.key)
        lastReceipt = receipt; baseline = receipt.access
        pending = nil; requiresReload = false; notice = .saved
    }

    private func refreshConfirmedPolicy(_ token: UUID, model: DexterAppModel) async {
        do {
            let value = try await model.loadBotExecutionAccess(botID: botID, ownerID: ownerID, session: session)
            guard accepts(token) else { return }
            guard value.botRevision >= (baseline?.botRevision ?? 0) else { throw HostClientError.contractMismatch }
            baseline = value
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
            let receipt = try await model.updateBotExecutionAccess(botID: botID, ownerID: ownerID, input: pending.input, session: session)
            guard accepts(token) else { return }
            try acceptReceipt(receipt, request: pending)
            await refreshConfirmedPolicy(token, model: model)
        } catch {
            guard accepts(token) else { return }
            requiresReload = true
            switch error as? HostClientError {
            case .invalidRequest, .forbidden, .notFound, .notReady:
                model.pendingBotExecutionAccessMutations.removeValue(forKey: pending.key)
                self.pending = nil; notice = .rejected
            case .conflict:
                // Replay is checked before CAS by the host. A definitive 409 has not accepted this request.
                model.pendingBotExecutionAccessMutations.removeValue(forKey: pending.key)
                self.pending = nil; notice = .conflict
                // A definitive CAS refusal is not an uncertain commit: exactly one bounded GET, never PATCH retry.
                do {
                    let value = try await model.loadBotExecutionAccess(botID: botID, ownerID: ownerID, session: session)
                    guard accepts(token) else { return }
                    baseline = value; requiresReload = false
                } catch {
                    guard accepts(token) else { return }
                    requiresReload = true
                }
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
            let receipt = try await model.reconcileBotExecutionAccess(botID: botID, ownerID: ownerID, input: pending.input, session: session)
            guard accepts(token) else { return }
            try acceptReceipt(receipt, request: pending)
            await refreshConfirmedPolicy(token, model: model)
        } catch {
            guard accepts(token) else { return }
            requiresReload = true
            if error as? HostClientError == .notFound {
                do {
                    let value = try await model.loadBotExecutionAccess(botID: botID, ownerID: ownerID, session: session)
                    guard accepts(token) else { return }
                    baseline = value; notice = .receiptMissing
                } catch {
                    guard accepts(token) else { return }; notice = .loadFailed
                }
            } else { notice = .saveUnknown }
        }
        guard accepts(token) else { return }; busy = false
    }
}
#endif
