import DexterHostClient
import Foundation
import Observation

public struct MemoryLearningPendingAction: Equatable, Sendable {
    public enum State: String, Equatable, Sendable { case awaitingDecision, running, applied, denied, failed, unknown }
    public let id: String; public let state: State; public let command: MemoryLearningCommand; public let action: Action?; public let receipt: MemoryLearningReceipt?
    public var actionID: String { id }
    public var summary: String { command.summary }; public var details: String { command.details }
}
/// One owner window and original request. Unknown proposal/decision ACKs are reconciled by GET only.
@MainActor @Observable public final class MemoryLearningEditor {
    public private(set) var status: MemoryLearningStatus?
    public private(set) var candidates: [MemoryLearningCandidate] = []
    public private(set) var records: [MemoryLearningRecord] = []
    public private(set) var jobs: [MemoryLearningJob] = []
    public private(set) var busy = false
    public private(set) var error: String?
    public private(set) var pendingAction: MemoryLearningPendingAction?
    public let session: SettingsEditorSession
    private let bot: Bot
    private weak var model: DexterAppModel?
    private var hostSession: OwnerConfigurationSession?
    private var namespace: McpRegistrationNamespace?
    private var original: MemoryLearningCommand?
    private var requestID: String?
    private var proposalSent = false
    private var decisionSent = false
    private var generation = UUID()
    private var invalidated = false
    public init(bot: Bot, model: DexterAppModel, session: SettingsEditorSession? = nil) { self.bot = bot; self.model = model; self.session = session ?? SettingsEditorSession(target: .bot(bot), model: model) }
    public var scopeMatches: Bool { guard !invalidated, let model else { return false }; return session.matches(botID: bot.id, ownerID: bot.ownerId, in: model) }
    public func invalidate() { invalidated = true; generation = UUID(); busy = false; error = "Esta janela perdeu a conexão com o bot original. Reabra os ajustes." }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }
    private func perform<Value: Sendable>(kind: SettingsEditorSession.OperationKind = .read, _ body: @MainActor (HostClient, OwnerConfigurationSession) async throws -> Value) async throws -> Value {
        guard scopeMatches, let model, let hostSession, let namespace else { throw HostClientError.forbidden }
        return try await session.perform(in: model, kind: kind) { client in
            let health = try await client.health()
            guard self.scopeMatches, client.baseURL == namespace.baseURL, try McpRegistrationNamespace(baseURL: client.baseURL, health: health) == namespace, hostSession.hostID == namespace.installationID, hostSession.ownerID == namespace.ownerID else { throw HostClientError.forbidden }
            return try await body(client, hostSession)
        }
    }
    public func load() async {
        guard scopeMatches, !busy, let model else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            if hostSession == nil {
                guard let hostID = session.effectiveHostID else { throw HostClientError.notReady }
                let opened = try await session.perform(in: model) { client -> (OwnerConfigurationSession, McpRegistrationNamespace) in
                    let health = try await client.health(); let namespace = try McpRegistrationNamespace(baseURL: client.baseURL, health: health)
                    guard self.scopeMatches, namespace.installationID == hostID, namespace.ownerID == self.bot.ownerId else { throw HostClientError.forbidden }
                    let opened = try await client.openOwnerConfiguration(bot: self.bot, expectedHostID: hostID, windowID: self.session.id)
                    return (opened, namespace)
                }
                guard accepts(token) else { return }; hostSession = opened.0; namespace = opened.1
            }
            try await refresh(token); error = nil
        } catch { if accepts(token) { self.error = Self.friendly(error) } }
    }
    private func refresh(_ token: UUID) async throws {
        let status = try await perform { try await $0.memoryLearningStatus($1) }; guard accepts(token) else { return }; self.status = status
        let candidates = try await perform { try await $0.memoryLearningCandidates($1) }; guard accepts(token) else { return }; self.candidates = candidates
        let records = try await perform { try await $0.memoryLearningRecords($1) }; guard accepts(token) else { return }; self.records = records
        let jobs = try await perform { try await $0.memoryLearningJobs($1) }; guard accepts(token) else { return }; self.jobs = jobs
    }
    public func propose(command: MemoryLearningCommand) async {
        guard scopeMatches, !busy, hostSession != nil else { return }
        if let pendingAction, [.applied, .denied, .failed].contains(pendingAction.state), pendingAction.state != .failed || !proposalSent { finishReview() }
        if original != nil { await reconcileGETONLY(); return }
        original = command; let id = UUID().uuidString.lowercased(); requestID = id; proposalSent = false; decisionSent = false
        pendingAction = .init(id: id, state: .running, command: command, action: nil, receipt: nil)
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            let action = try await perform(kind: .mutation) { client, s in
                try await client.proposeMemoryLearning(s, command: command, clientRequestId: id, beforeDispatch: {
                    guard self.accepts(token), self.original == command, self.requestID == id else { throw HostClientError.forbidden }
                    self.proposalSent = true
                })
            }
            guard accepts(token) else { return }; accept(action, command: command)
        } catch { guard accepts(token) else { return }; pendingAction = .init(id: id, state: proposalSent ? .unknown : .failed, command: command, action: nil, receipt: nil); self.error = Self.friendly(error) }
    }
    public func approveCurrent() async { await decide(.allow) }
    public func denyCurrent() async { await decide(.deny) }
    private func decide(_ decision: ApprovalDecision) async {
        guard scopeMatches, !busy, pendingAction?.state == .awaitingDecision, let action = pendingAction?.action, let command = original, let id = requestID else { return }
        if decisionSent { await reconcileGETONLY(); return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            let value = try await perform(kind: .mutation) { client, s in
                try await client.decideMemoryLearning(s, clientRequestId: id, command: command, action: action, decision: decision, beforeDispatch: {
                    guard self.accepts(token), self.pendingAction?.action?.requestHash == action.requestHash, !self.decisionSent else { throw HostClientError.forbidden }
                    self.decisionSent = true; self.pendingAction = .init(id: action.id, state: .running, command: command, action: action, receipt: nil)
                })
            }
            guard accepts(token) else { return }; accept(value, command: command)
            let effect = try await perform { try await $0.memoryLearningReceipt($1, actionID: value.id) }; guard accepts(token) else { return }; accept(effect.action, command: command, receipt: effect.receipt); try await refresh(token)
        } catch { guard accepts(token) else { return }; pendingAction = .init(id: action.id, state: .unknown, command: command, action: action, receipt: nil); self.error = Self.friendly(error) }
    }
    public func reconcile() async { await reconcileGETONLY() }
    public func reconcileGETONLY() async {
        guard scopeMatches, !busy, proposalSent, let command = original, let id = requestID else { return }
        busy = true; let token = generation; defer { if token == generation { busy = false } }
        do {
            let observation = try await perform { try await $0.memoryLearningRequest($1, clientRequestId: id, command: command) }
            guard accepts(token) else { return }; guard let action = observation.action else { pendingAction = .init(id: id, state: .unknown, command: command, action: nil, receipt: nil); error = "O host ainda não confirmou esta proposta. Consulte novamente; ela não foi reenviada."; return }
            if let previous = pendingAction?.action { guard previous.id == action.id, previous.requestHash == action.requestHash, previous.request == action.request else { throw HostClientError.contractMismatch } }
            let effect = try await perform { try await $0.memoryLearningReceipt($1, actionID: action.id) }; guard accepts(token) else { return }
            accept(effect.action, command: command, receipt: effect.receipt); try await refresh(token); error = nil
        } catch { if accepts(token) { self.error = Self.friendly(error) } }
    }
    public func finishReview() {
        guard !busy, pendingAction.map({ [.applied, .denied, .failed].contains($0.state) }) == true, pendingAction?.state != .failed || !proposalSent else { return }
        original = nil; requestID = nil; pendingAction = nil; proposalSent = false; decisionSent = false; error = nil
    }
    private func accept(_ action: Action, command: MemoryLearningCommand, receipt: MemoryLearningReceipt? = nil) {
        let state: MemoryLearningPendingAction.State
        switch action.state { case .awaitingApproval: state = .awaitingDecision; case .ready, .running: state = .running; case .succeeded: state = receipt == nil ? .unknown : .applied; case .denied: state = .denied; case .blocked: state = .failed; case .unknown: state = .unknown }
        pendingAction = .init(id: action.id, state: state, command: command, action: action, receipt: receipt)
    }
    private static func friendly(_ error: any Error) -> String {
        switch error as? HostClientError { case .forbidden: "Esta sessão não tem mais acesso ao bot. Reabra os ajustes."; case .conflict: "A memória ou a política mudou. Atualize e revise uma nova proposta."; case .offline, .hostFailure: "O host está indisponível. A operação não será reenviada automaticamente."; case .contractMismatch: "A resposta do host não corresponde à proposta original. Reabra esta conexão."; case .invalidRequest: "Revise os valores e limites da proposta."; default: "Resultado ainda não confirmado. Use Consultar resultado; isso apenas lê o host." }
    }
}
