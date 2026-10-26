import DexterHostClient
import Foundation
import Observation

/// Technical coordinator for one real human settings window. Rendering/wording belongs to the consuming UI.
/// Holds original bodies across uncertainty and retires callbacks when its host/window/bot namespace changes.
@MainActor @Observable public final class OwnerConfigurationEditor {
    public enum State: Equatable, Sendable { case idle, prepared, submitting, awaitingApproval, unknown, decided, rejected, invalidated }
    public let session: SettingsEditorSession
    public let botID: String
    public let ownerID: String
    public private(set) var hostSession: OwnerConfigurationSession?
    public private(set) var namespace: McpRegistrationNamespace?
    public private(set) var original: OwnerConfigurationProposal?
    public private(set) var action: Action?
    public private(set) var mcpReview: McpInstanceSelectionReview?
    public private(set) var memoryPolicy: MemoryRoutinePolicyStatus?
    public private(set) var jobs: [MemoryRoutineJob] = []
    public private(set) var state: State = .idle
    public private(set) var lastError: HostClientError?
    public private(set) var busy = false
    public private(set) var mutationSent = false
    public private(set) var invalidated = false
    @ObservationIgnored private weak var model: DexterAppModel?
    @ObservationIgnored private var generation = UUID()

    public init(bot: Bot, model: DexterAppModel, session: SettingsEditorSession? = nil) {
        botID = bot.id; ownerID = bot.ownerId; self.model = model
        self.session = session ?? SettingsEditorSession(target: .bot(bot), model: model)
    }
    public var scopeMatches: Bool {
        guard !invalidated, let model else { return false }
        return session.matches(botID: botID, ownerID: ownerID, in: model)
    }
    public var requiresReconciliation: Bool { mutationSent && (state == .submitting || state == .unknown) }
    public func invalidate() {
        invalidated = true; generation = UUID(); busy = false; state = .invalidated
        // The original request/action remain available as history. A new base receives no replay.
    }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }

    /// Explicit open/renew of this same window. It cannot submit or approve an original uncertain mutation.
    public func open() async {
        guard scopeMatches, !busy, let model,
              let bot = model.bots.first(where: { $0.id == botID && $0.ownerId == ownerID }),
              let hostID = session.effectiveHostID else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            let value = try await session.perform(in: model) { client -> (OwnerConfigurationSession, McpRegistrationNamespace) in
                let health = try await client.health()
                guard self.scopeMatches else { throw HostClientError.forbidden }
                let namespace = try McpRegistrationNamespace(baseURL: client.baseURL, health: health)
                guard namespace.installationID == hostID, namespace.ownerID == self.ownerID,
                      self.namespace == nil || self.namespace == namespace else { throw HostClientError.forbidden }
                let opened = try await client.openOwnerConfiguration(bot: bot, expectedHostID: hostID, windowID: self.session.id)
                return (opened, namespace)
            }
            guard accepts(token) else { return }
            hostSession = value.0; namespace = value.1; lastError = nil
        } catch {
            guard accepts(token) else { return }; lastError = Self.error(error)
        }
    }
    /// Deliberate reads only. Refresh never creates capture jobs, re-applies a plan or resends an action.
    public func refreshMcp() async {
        guard !busy, let hostSession else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do { let value = try await perform { try await $0.ownerMcpSelection(hostSession) }; guard accepts(token) else { return }; mcpReview = value; lastError = nil }
        catch { guard accepts(token) else { return }; lastError = Self.error(error) }
    }
    public func refreshMemory() async {
        guard !busy, let hostSession else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            let policy = try await perform { try await $0.ownerMemoryPolicy(hostSession) }
            guard accepts(token) else { return }; memoryPolicy = policy
            let list = try await perform { try await $0.ownerMemoryJobs(hostSession) }
            guard accepts(token) else { return }; jobs = list; lastError = nil
        } catch { guard accepts(token) else { return }; lastError = Self.error(error) }
    }
    public func catalog(serverID: String) async throws -> McpInstanceSelectionCatalog {
        guard let hostSession else { throw HostClientError.notReady }
        return try await perform { try await $0.ownerMcpCatalog(hostSession, serverID: serverID) }
    }
    public func plan(_ input: McpInstanceSelectionInput) async throws -> McpInstanceSelectionPlan {
        guard let hostSession else { throw HostClientError.notReady }
        return try await perform { try await $0.ownerMcpPlan(hostSession, input: input) }
    }
    public func job(_ id: String) async throws -> MemoryRoutineJobObservation {
        guard let hostSession else { throw HostClientError.notReady }
        return try await perform { try await $0.ownerMemoryJob(hostSession, jobID: id) }
    }
    public func maintenancePreview() async throws -> MemoryMaintenancePreview {
        guard let hostSession else { throw HostClientError.notReady }
        return try await perform { try await $0.ownerMemoryMaintenancePreview(hostSession) }
    }
    public func mcpReceipt() async throws -> McpInstanceSelectionReceiptObservation {
        guard let hostSession, let action, original?.operation == .mcpSelection else { throw HostClientError.notReady }
        return try await perform { try await $0.ownerMcpReceipt(hostSession, actionID: action.id) }
    }
    public func policyReceipt() async throws -> MemoryRoutinePolicyReceiptObservation {
        guard let hostSession, let action, original?.operation == .memoryPolicy else { throw HostClientError.notReady }
        return try await perform { try await $0.ownerMemoryPolicyReceipt(hostSession, actionID: action.id) }
    }

    /// This only captures the human's reviewed proposal. Each resulting action still needs an exact decision.
    public func prepare(_ proposal: OwnerConfigurationProposal) throws {
        guard scopeMatches, !busy, original == nil else { throw HostClientError.conflict }
        original = proposal; action = nil; mutationSent = false; state = .prepared; lastError = nil
    }
    public func discardPrepared() throws {
        guard scopeMatches, !busy, !mutationSent, state == .prepared else { throw HostClientError.conflict }
        original = nil; action = nil; state = .idle; lastError = nil
    }
    /// Exactly one POST for this intention. Re-entering this method after sending performs a GET-only reconcile.
    public func submit() async {
        if mutationSent { await reconcile(); return }
        guard scopeMatches, !busy, state == .prepared, let original, let hostSession else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            let value = try await perform(kind: .mutation) { client in
                try await client.proposeOwnerConfiguration(hostSession, original: original, beforeDispatch: {
                    guard token == self.generation, !self.invalidated else { throw HostClientError.forbidden }
                    guard self.scopeMatches else { self.invalidate(); throw HostClientError.forbidden }
                    try Task.checkCancellation()
                    guard self.original == original, self.hostSession == hostSession else { throw HostClientError.conflict }
                    self.mutationSent = true; self.state = .submitting
                })
            }
            guard accepts(token) else { return }; action = value; accept(value); lastError = nil
        } catch {
            guard token == generation else { return }
            guard scopeMatches else { invalidate(); return }
            if !mutationSent {
                state = .prepared
                lastError = Task.isCancelled ? nil : Self.error(error)
                return
            }
            state = .unknown; lastError = Self.error(error)
        }
        // One bounded original receipt read even after an ambiguous ACK. No automatic repost/new ID.
        guard accepts(token) else { return }; await readOriginal(original, token: token)
    }
    public func reconcile() async {
        guard scopeMatches, !busy, mutationSent, let original, hostSession != nil else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        await readOriginal(original, token: token)
    }
    private func readOriginal(_ original: OwnerConfigurationProposal, token: UUID) async {
        guard let hostSession else { return }
        do {
            let value = try await perform { try await $0.ownerConfigurationRequestReceipt(hostSession, original: original) }
            guard accepts(token) else { return }
            guard let current = value.action else { state = .unknown; lastError = .mutationOutcomeUnknown; return }
            if let action, action.id != current.id || action.requestHash != current.requestHash || action.request != current.request { throw HostClientError.contractMismatch }
            action = current; accept(current); lastError = nil
        } catch { guard accepts(token) else { return }; state = .unknown; lastError = Self.error(error) }
    }
    /// Called only by the explicit owner Allow/Deny gesture. Receipt uncertainty is resolved through reads.
    public func decide(_ decision: ApprovalDecision) async {
        guard scopeMatches, !busy, state == .awaitingApproval, let original, let action, let hostSession else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            let value = try await perform(kind: .mutation) { try await $0.decideOwnerConfiguration(hostSession, original: original, action: action, decision: decision) }
            guard accepts(token) else { return }; self.action = value; accept(value); lastError = nil
        } catch { guard accepts(token) else { return }; state = .unknown; lastError = Self.error(error) }
        guard accepts(token) else { return }; await readOriginal(original, token: token)
    }
    /// Starts another review only after the prior action is terminal. Unknown remains preserved and blocks it.
    public func finishReview() throws {
        guard scopeMatches, !busy, state == .decided || state == .rejected else { throw HostClientError.conflict }
        original = nil; action = nil; mutationSent = false; state = .idle; lastError = nil
    }
    private func accept(_ action: Action) {
        switch action.state {
        case .awaitingApproval: state = .awaitingApproval
        case .ready, .running, .unknown: state = .unknown
        case .succeeded: state = .decided
        case .denied, .blocked: state = .rejected
        }
    }
    private func perform<Value: Sendable>(kind: SettingsEditorSession.OperationKind = .read,
        _ operation: @MainActor (HostClient) async throws -> Value) async throws -> Value {
        guard scopeMatches, let model, let namespace, let hostSession else { throw HostClientError.forbidden }
        return try await session.perform(in: model, kind: kind) { client in
            let health = try await client.health()
            guard self.scopeMatches, client.baseURL == namespace.baseURL,
                  try McpRegistrationNamespace(baseURL: client.baseURL, health: health) == namespace,
                  hostSession.hostID == namespace.installationID, hostSession.ownerID == namespace.ownerID else { throw HostClientError.forbidden }
            return try await operation(client)
        }
    }
    private static func error(_ error: any Error) -> HostClientError { error as? HostClientError ?? .mutationOutcomeUnknown }
}
