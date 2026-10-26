#if os(macOS)
import Foundation
import Observation
import DexterHostClient

/// Nonsecret channel metadata is retained across Settings closes. Secrets belong only to a one-shot frame.
@MainActor public struct MemoryBackendPrivateChannel {
    public let available: (String) -> Bool
    public let send: (MemoryBackendPrivateFrame) async throws -> Void
    public let reconcile: (MemoryBackendPrivateIntent, MemoryBackendStatus) -> Bool
    public let uncertain: () -> MemoryBackendPrivateIntent?
    public init(available: @escaping (String) -> Bool, send: @escaping (MemoryBackendPrivateFrame) async throws -> Void,
                reconcile: @escaping (MemoryBackendPrivateIntent, MemoryBackendStatus) -> Bool,
                uncertain: @escaping () -> MemoryBackendPrivateIntent?) {
        self.available = available; self.send = send; self.reconcile = reconcile; self.uncertain = uncertain
    }
}

@MainActor @Observable public final class MemoryBackendSettingsEditor {
    public enum Notice: Equatable, Sendable {
        case loadFailed, hostChanged, conflict, settingsUnknown, privateUnknown, saved, ready, locked, refused, wrappingUnavailable, signingUnavailable
        public var message: String {
            switch self {
            case .loadFailed: String(localized: "Não foi possível consultar esta configuração. Verifique a conexão e consulte novamente.")
            case .hostChanged: String(localized: "A base mudou. Reabra os ajustes na base correta.")
            case .conflict: String(localized: "A configuração mudou. Consulte o estado atual antes de salvar.")
            case .settingsUnknown: String(localized: "O resultado do salvamento é desconhecido. Verificar estado consulta o receipt original; não reenvia a alteração.")
            case .privateUnknown: String(localized: "A confirmação privada não chegou. Verificar estado consulta o pedido original; não reenvia credenciais. Você também pode bloquear.")
            case .saved: String(localized: "Configuração salva no host.")
            case .ready: String(localized: "Custódia privada desbloqueada. A busca semântica ainda precisa ser comprovada.")
            case .locked: String(localized: "Custódia privada bloqueada.")
            case .refused: String(localized: "O host recusou o pedido privado. Consulte o estado; confira origem, revisão e permissão da chave.")
            case .wrappingUnavailable: String(localized: "A chave privada deste escopo está ausente ou indisponível. Nenhuma chave de outra origem será usada.")
            case .signingUnavailable: String(localized: "A custódia privada exige uma identidade de assinatura autorizada. Use o pacote assinado apropriado e confira o estado antes de tentar outra operação.")
            }
        }
    }
    public let hostID: String
    public private(set) var ownerID: String?
    public private(set) var status: MemoryBackendStatus?
    public private(set) var wrappingStatus: MemoryBackendWrappingStatus = .unavailable
    public private(set) var busy = false
    public private(set) var requiresRefresh = false
    public private(set) var notice: Notice?
    public private(set) var pendingSettings: MemoryBackendSettingsInput?
    public private(set) var pendingPrivate: MemoryBackendPrivateIntent?
    public var origin = ""
    public var enabled = false
    public var administrativeRole: MemoryBackendAdministrativeRole = .root
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let isCurrent: () -> Bool
    @ObservationIgnored private let channel: MemoryBackendPrivateChannel
    @ObservationIgnored private let wrapping: any MemoryBackendWrappingStore
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var active = false
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(hostID: String, client: HostClient, isCurrent: @escaping () -> Bool,
                channel: MemoryBackendPrivateChannel, wrapping: any MemoryBackendWrappingStore) {
        self.hostID = hostID; self.client = client; self.isCurrent = isCurrent; self.channel = channel; self.wrapping = wrapping
    }
    public var scopeMatches: Bool { active && isCurrent() }
    public var scope: MemoryBackendWrappingScope? {
        guard let ownerID, let origin = status?.settings.origin else { return nil }
        return try? MemoryBackendWrappingScope(hostID: hostID, ownerID: ownerID, origin: origin)
    }
    public var dirty: Bool { status.map { origin != ($0.settings.origin ?? "") || enabled != $0.settings.enabled } ?? false }
    public var canEdit: Bool { scopeMatches && status != nil && !busy && !requiresRefresh && pendingSettings == nil && pendingPrivate == nil && status?.state != .configuredExternally }
    public var canSave: Bool { canEdit && dirty && (try? memoryBackendOrigin(origin)) != nil }
    public var canInitialize: Bool { privateAllowed && pendingPrivate == nil && status?.state == .privateUnlockRequired && (wrappingStatus == .missing || wrappingStatus == .configured) }
    public var canUnlock: Bool { canInitialize && wrappingStatus == .configured }
    public var canLock: Bool { scopeMatches && !busy && pendingSettings == nil && scope != nil && channel.available(hostID) && status?.state != .configuredExternally }
    private var privateAllowed: Bool { scopeMatches && !busy && !requiresRefresh && !dirty && pendingSettings == nil && scope != nil && status?.settings.enabled == true && channel.available(hostID) }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }
    public func open() { active = true; if !busy { verify() } }
    public func close() {
        active = false; generation = UUID(); task?.cancel(); task = nil; busy = false
        // Original intentions survive dismissal; no close/reopen path turns uncertainty into a retry.
        if pendingSettings != nil { notice = .settingsUnknown }
        if pendingPrivate != nil { notice = .privateUnknown }
    }
    private func apply(_ value: MemoryBackendStatus, resetDraft: Bool) {
        status = value
        requiresRefresh = false
        if resetDraft { origin = value.settings.origin ?? ""; enabled = value.settings.enabled }
        wrappingStatus = scope.map { wrapping.status(scope: $0) } ?? .unavailable
    }
    private func readCurrent(_ token: UUID) async throws -> MemoryBackendStatus {
        guard accepts(token), case .loopbackDevelopment = client.accessPolicy else { throw HostClientError.forbidden }
        let health = try await client.health()
        guard accepts(token), health.hostId == hostID, case .object(let state) = health.state,
              state["hostId"] == .string(hostID), case .string(let owner) = state["ownerId"], memoryBackendID(owner),
              ownerID == nil || ownerID == owner else { throw HostClientError.contractMismatch }
        ownerID = owner
        let value = try await client.memoryBackendStatus()
        guard accepts(token) else { throw CancellationError() }; return value
    }
    /// GET only. Original receipt/request identity, not an apparent final state, decides recovery.
    public func verify() {
        guard scopeMatches, !busy else { return }; let token = generation; busy = true
        task = Task { @MainActor in
            defer { if token == generation { busy = false; task = nil } }
            do {
                var value = try await readCurrent(token)
                if let input = pendingSettings, let ownerID {
                    if let receipt = try await client.memoryBackendSettingReceipt(input, ownerID: ownerID) {
                        guard accepts(token), receipt.matches(input, ownerID: ownerID) else { return }
                        pendingSettings = nil; notice = .saved
                        value = try await readCurrent(token)
                    } else { notice = .settingsUnknown }
                }
                guard accepts(token) else { return }
                if pendingPrivate == nil { pendingPrivate = channel.uncertain() }
                if let intent = pendingPrivate {
                    if channel.reconcile(intent, value) {
                        pendingPrivate = nil
                        notice = value.privateRequest?.state == "locked" ? .locked : value.privateRequest?.state == "refused" ? .refused : .ready
                    } else { notice = .privateUnknown }
                }
                apply(value, resetDraft: pendingSettings == nil)
            } catch { if accepts(token) { notice = (error as? HostClientError) == .contractMismatch ? .hostChanged : .loadFailed } }
        }
    }
    public func save() {
        guard canSave, let status, let ownerID,
              let input = try? MemoryBackendSettingsInput(expectedHostId:hostID,clientRequestId:UUID().uuidString.lowercased(),
                    expectedRevision:status.settings.revision,origin:origin,enabled:enabled) else { return }
        pendingSettings = input; let token = generation; busy = true; notice = nil
        task = Task { @MainActor in
            defer { if token == generation { busy = false; task = nil } }
            do {
                guard accepts(token) else { return }
                let result = try await client.updateMemoryBackendSettings(input, ownerID:ownerID)
                guard accepts(token) else { return }
                // The mutation receipt proves this save; an unrelated later status cannot substitute for it.
                pendingSettings = nil; apply(result.status,resetDraft:true); notice = .saved
            } catch {
                guard accepts(token) else { return }
                switch error as? HostClientError {
                case .conflict: pendingSettings = nil; requiresRefresh = true; notice = .conflict
                case .forbidden, .invalidRequest: pendingSettings = nil; notice = .refused
                default: notice = .settingsUnknown
                }
            }
        }
    }
    public func initialize(administrative: MemoryBackendOwnedSecret) {
        guard canInitialize else { administrative.clear(); return }; perform(.create, administrative: administrative)
    }
    public func unlock() { guard canUnlock else { return }; perform(.unlock) }
    public func lock() { guard canLock else { return }; perform(.lock) }
    private func perform(_ operation: MemoryBackendPrivateOperation, administrative: MemoryBackendOwnedSecret? = nil) {
        guard let previous = status, let scope else { administrative?.clear(); return }
        let token = generation, role = administrativeRole; busy = true; notice = nil
        task = Task { @MainActor in
            defer { administrative?.clear(); if token == generation { busy = false; task = nil } }
            do {
                // Revalidate selected host, owner, origin and revision BEFORE any key value read/create or private handoff.
                let current = try await readCurrent(token)
                guard accepts(token), channel.available(hostID), current.settings == previous.settings,
                      self.scope == scope, current.state != .restartRequired && current.state != .configuredExternally,
                      operation == .lock || current.state == .privateUnlockRequired && current.settings.enabled,
                      operation == .lock || pendingPrivate == nil && channel.uncertain() == nil else { throw HostClientError.conflict }
                let intent = try MemoryBackendPrivateIntent(scope:scope,expectedRevision:current.settings.revision,operation:operation)
                let frame: MemoryBackendPrivateFrame
                switch operation {
                case .create:
                    guard let administrative else { throw MemoryBackendPrivateFailure.refused }
                    let key: MemoryBackendOwnedSecret
                    switch wrapping.status(scope:scope) {
                    case .missing: key = try wrapping.create(scope:scope)
                    case .configured: key = try wrapping.load(scope:scope)
                    case .unavailable: throw MemoryBackendPrivateFailure.wrappingKeyUnavailable
                    case .signingIdentityUnavailable: throw MemoryBackendPrivateFailure.signingIdentityUnavailable
                    }
                    wrappingStatus = .configured
                    frame = try .create(intent,wrapping:key,administrative:administrative,role:role)
                case .unlock: frame = try .unlock(intent,wrapping:wrapping.load(scope:scope),role:role)
                case .lock: frame = try .lock(intent)
                }
                guard accepts(token), channel.available(hostID) else { frame.clear(); throw HostClientError.forbidden }
                pendingPrivate = intent
                try await channel.send(frame)
                guard accepts(token) else { return }
                pendingPrivate = nil; notice = operation == .lock ? .locked : .ready
                apply(try await readCurrent(token), resetDraft:true)
            } catch {
                guard accepts(token) else { return }
                switch error as? MemoryBackendPrivateFailure {
                case .outcomeUnknown: notice = .privateUnknown
                case .refused: pendingPrivate = nil; notice = .refused
                case .missingWrappingKey, .wrappingKeyExists, .wrappingKeyUnavailable: notice = .wrappingUnavailable
                case .signingIdentityUnavailable: notice = .signingUnavailable
                default: requiresRefresh = true; notice = pendingPrivate == nil ? .conflict : .privateUnknown
                }
            }
        }
    }
}
#endif
