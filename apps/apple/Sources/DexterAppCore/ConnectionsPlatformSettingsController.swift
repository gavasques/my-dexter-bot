#if os(macOS)
import Foundation
import Observation
import DexterHostClient

/// Owner-private configuration of the connections service for THIS Mac's own host (owner loopback only).
///
/// - Metadata (origin, enable intent, credential generation) is saved on the host with CAS + receipt; an uncertain save
///   keeps the original request and is settled by GET of its receipt, never by a second write.
/// - The capability is entered once by the owner, kept in Keychain custody for the exact host/owner/origin/generation the
///   running service was composed with, and delivered only over the owned child's private pipe. An uncertain delivery or
///   lock is settled by GET of the host's last private request (exact request id), never by resending.
/// - Saving is not connecting: `requiresRestart` until the host restarts; connectivity is the connections status/catalog.
@MainActor @Observable public final class ConnectionsPlatformSettingsController {
    public enum Notice: Equatable, Sendable {
        case loadFailed, hostChanged, conflict, settingsUnknown, privateUnknown, saved, restartRequired, ready, locked, refused
        case capabilityExists, capabilityMissing, capabilityUnavailable, signingUnavailable, channelUnavailable, invalidCapability
        public var message: String {
            switch self {
            case .loadFailed: String(localized: "Não foi possível consultar esta configuração. Verifique a conexão e consulte novamente.")
            case .hostChanged: String(localized: "A base mudou. Reabra os ajustes na base correta.")
            case .conflict: String(localized: "A configuração mudou. Consulte o estado atual antes de salvar.")
            case .settingsUnknown: String(localized: "O resultado do salvamento é desconhecido. Verificar estado consulta o receipt original; não reenvia a alteração.")
            case .privateUnknown: String(localized: "A confirmação privada não chegou. Verificar estado consulta o pedido original; a credencial não é reenviada.")
            case .saved: String(localized: "Configuração salva no host. Isso não significa conectado.")
            case .restartRequired: String(localized: "Salvo. O serviço de conexões só passa a valer depois de reiniciar o host deste Mac.")
            case .ready: String(localized: "Credencial entregue ao host pelo canal privado. A conexão ainda precisa ser comprovada pelo catálogo.")
            case .locked: String(localized: "Credencial bloqueada no host.")
            case .refused: String(localized: "O host recusou a credencial. Confira a origem e a geração e consulte o estado.")
            case .capabilityExists: String(localized: "Já existe uma credencial guardada para esta origem e geração. Para trocar, gere uma nova geração.")
            case .capabilityMissing: String(localized: "Nenhuma credencial guardada para esta origem e geração.")
            case .capabilityUnavailable: String(localized: "A credencial guardada está indisponível. Nenhuma credencial de outra origem será usada.")
            case .signingUnavailable: String(localized: "A custódia privada exige uma identidade de assinatura autorizada. Use o pacote assinado apropriado.")
            case .channelUnavailable: String(localized: "O canal privado com o host deste Mac não está disponível. Nada foi enviado.")
            case .invalidCapability: String(localized: "Credencial em formato inválido. Nada foi guardado.")
            }
        }
    }
    public let hostID: String
    public private(set) var ownerID: String?
    public private(set) var status: ConnectionsConfigurationStatus?
    public private(set) var capabilityStatus: ConnectionsCapabilityStatus = .unavailable
    public private(set) var busy = false
    public private(set) var notice: Notice?
    public private(set) var pendingSettings: ConnectionsConfigurationInput?
    public private(set) var pendingPrivate: ConnectionsPrivateIntent?
    public var origin = ""
    public var enabled = false
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let isCurrent: () -> Bool
    @ObservationIgnored private let channel: ConnectionsPrivateChannel
    @ObservationIgnored private let store: any ConnectionsCapabilityStore
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var active = false
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(hostID: String, client: HostClient, isCurrent: @escaping () -> Bool, channel: ConnectionsPrivateChannel, store: any ConnectionsCapabilityStore) {
        self.hostID = hostID; self.client = client; self.isCurrent = isCurrent; self.channel = channel; self.store = store
    }
    public var scopeMatches: Bool { active && isCurrent() }
    /// The exact custody scope the running service accepts (nil unless the runtime is active).
    public var scope: ConnectionsCapabilityScope? {
        guard let ownerID, let active = status?.activeCredentialScope else { return nil }
        return try? ConnectionsCapabilityScope(hostID: hostID, ownerID: ownerID, origin: active.origin, generation: active.generation)
    }
    private var draftOrigin: String? { origin.isEmpty ? nil : (try? connectionsPlatformOrigin(origin)) }
    public var dirty: Bool { status.map { (origin.isEmpty ? nil : origin) != $0.configuration.origin || enabled != $0.configuration.enabled } ?? false }
    public var requiresRestart: Bool { status?.runtime.state == .restartRequired }
    public var canEdit: Bool {
        scopeMatches && status != nil && !busy && pendingSettings == nil && pendingPrivate == nil && status?.runtime.state != .configuredExternally
    }
    public var canSave: Bool { canEdit && dirty && (origin.isEmpty ? !enabled : draftOrigin != nil) }
    public var canRenewCredential: Bool { canEdit && !dirty && status?.configuration.origin != nil }
    private var privateAllowed: Bool {
        scopeMatches && !busy && pendingSettings == nil && pendingPrivate == nil && scope != nil && channel.available(hostID) && status?.custody.channel == .appPrivateChannel
    }
    public var canStoreCapability: Bool { privateAllowed && capabilityStatus == .missing }
    public var canDeliver: Bool { privateAllowed && capabilityStatus == .configured && status?.custody.state != .ready }
    public var canLock: Bool { privateAllowed && status?.custody.state == .ready }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }

    /// Reads (GET) and, when the running service waits for a credential this Mac already keeps, restores it once.
    public func open() { active = true; if !busy { verify(restoreFromCustody: true) } }
    public func close() {
        active = false; generation = UUID(); task?.cancel(); task = nil; busy = false
        if pendingSettings != nil { notice = .settingsUnknown }
        if pendingPrivate != nil { notice = .privateUnknown }
    }
    private func apply(_ value: ConnectionsConfigurationStatus, resetDraft: Bool) {
        status = value
        if resetDraft { origin = value.configuration.origin ?? ""; enabled = value.configuration.enabled }
        capabilityStatus = scope.map { store.status(scope: $0) } ?? .unavailable
    }
    private func readCurrent(_ token: UUID) async throws -> ConnectionsConfigurationStatus {
        guard accepts(token), case .loopbackDevelopment = client.accessPolicy else { throw HostClientError.forbidden }
        let health = try await client.health()
        guard accepts(token), health.hostId == hostID, case .object(let state) = health.state, state["hostId"] == .string(hostID),
              case .string(let owner) = state["ownerId"], memoryBackendID(owner), ownerID == nil || ownerID == owner else { throw HostClientError.contractMismatch }
        ownerID = owner
        let value = try await client.connectionsConfigurationStatus()
        guard accepts(token), value.hostId == hostID, value.ownerId == owner else { throw HostClientError.contractMismatch }
        return value
    }
    /// GET only. The original receipt / private request id, never an apparent final state, settles uncertainty.
    public func verify(restoreFromCustody: Bool = false) {
        guard scopeMatches, !busy else { return }; let token = generation; busy = true
        task = Task { @MainActor in
            defer { if token == generation { busy = false; task = nil } }
            do {
                var value = try await readCurrent(token)
                if let input = pendingSettings, let ownerID {
                    if let receipt = try await client.connectionsConfigurationReceipt(input, ownerID: ownerID) {
                        guard accepts(token) else { return }
                        pendingSettings = nil; notice = receipt.restartRequired ? .restartRequired : .saved
                        value = try await readCurrent(token)
                    } else { notice = .settingsUnknown }
                }
                guard accepts(token) else { return }
                if pendingPrivate == nil { pendingPrivate = channel.uncertain() }
                if let intent = pendingPrivate {
                    if channel.reconcile(intent, value) {
                        pendingPrivate = nil
                        notice = value.privateRequest?.state == .refused ? .refused : intent.operation == .lock ? .locked : .ready
                    } else { notice = .privateUnknown }
                }
                apply(value, resetDraft: pendingSettings == nil)
                // After this read settles (busy cleared by the defer): one restore from custody, never a retry loop.
                if restoreFromCustody { Task { @MainActor in if self.canDeliver { self.deliverStoredCapability() } } }
            } catch { if accepts(token) { notice = (error as? HostClientError) == .contractMismatch ? .hostChanged : .loadFailed } }
        }
    }
    /// Owner gesture: saves metadata only. A new origin (or `renewCredential`) starts a new credential generation.
    public func save(renewCredential: Bool = false) {
        guard renewCredential ? canRenewCredential : canSave, let status, let ownerID,
              let input = try? ConnectionsConfigurationInput(expectedHostId: hostID, clientRequestId: UUID().uuidString.lowercased(),
                    expectedRevision: status.configuration.revision, origin: renewCredential ? status.configuration.origin : draftOrigin,
                    enabled: renewCredential ? status.configuration.enabled : enabled, renewCredential: renewCredential) else { return }
        pendingSettings = input; let token = generation; busy = true; notice = nil
        task = Task { @MainActor in
            defer { if token == generation { busy = false; task = nil } }
            do {
                guard accepts(token) else { return }
                let result = try await client.updateConnectionsConfiguration(input, ownerID: ownerID)
                guard accepts(token) else { return }
                pendingSettings = nil; apply(result.status, resetDraft: true); notice = result.receipt.restartRequired ? .restartRequired : .saved
            } catch {
                guard accepts(token) else { return }
                switch error as? HostClientError {
                case .conflict: pendingSettings = nil; notice = .conflict
                case .invalidRequest, .forbidden: pendingSettings = nil; notice = .loadFailed
                default: notice = .settingsUnknown // pending kept: only GET of the original receipt decides
                }
            }
        }
    }
    /// Owner gesture: keeps the pasted capability in custody for the running scope, then delivers it privately.
    public func storeCapability(_ capability: ConnectionsOwnedCapability) {
        guard canStoreCapability, let scope else { capability.clear(); return }
        do { try store.save(scope: scope, capability: capability) }
        catch ConnectionsPrivateFailure.capabilityExists { notice = .capabilityExists; return }
        catch ConnectionsPrivateFailure.signingIdentityUnavailable { notice = .signingUnavailable; capabilityStatus = .signingIdentityUnavailable; return }
        catch { notice = .capabilityUnavailable; return }
        capabilityStatus = store.status(scope: scope)
        deliverStoredCapability()
    }
    /// Loads the custody item of the exact running scope and sends it once. No other scope is ever tried.
    public func deliverStoredCapability() {
        guard canDeliver, let scope else { return }
        let capability: ConnectionsOwnedCapability
        do { capability = try store.load(scope: scope) }
        catch ConnectionsPrivateFailure.missingCapability { notice = .capabilityMissing; capabilityStatus = .missing; return }
        catch ConnectionsPrivateFailure.signingIdentityUnavailable { notice = .signingUnavailable; return }
        catch { notice = .capabilityUnavailable; return }
        guard let intent = try? ConnectionsPrivateIntent(scope: scope, operation: .set), let frame = try? ConnectionsPrivateFrame.set(intent, capability: capability)
        else { capability.clear(); notice = .invalidCapability; return }
        send(frame)
    }
    public func lock() {
        guard canLock, let scope, let intent = try? ConnectionsPrivateIntent(scope: scope, operation: .lock), let frame = try? ConnectionsPrivateFrame.lock(intent) else { return }
        send(frame)
    }
    /// Explicit owner removal of this scope's custody item (locks the host copy first when it is ready).
    public func forgetCapability() {
        guard let scope, scopeMatches, !busy, pendingPrivate == nil else { return }
        if status?.custody.state == .ready { lock() }
        do { try store.remove(scope: scope); capabilityStatus = store.status(scope: scope) } catch { notice = .capabilityUnavailable }
    }
    private func send(_ frame: ConnectionsPrivateFrame) {
        let intent = frame.intent, token = generation; pendingPrivate = intent; busy = true; notice = nil
        task = Task { @MainActor in
            defer { if token == generation { busy = false; task = nil } }
            do {
                try await channel.send(frame)
                guard accepts(token) else { return }
                pendingPrivate = nil; notice = intent.operation == .set ? .ready : .locked
            } catch {
                frame.clear()
                guard accepts(token) else { return }
                switch error as? ConnectionsPrivateFailure {
                case .refused: pendingPrivate = nil; notice = .refused
                case .bridgeUnavailable: pendingPrivate = nil; notice = .channelUnavailable // never written
                default: notice = .privateUnknown // kept: GET of the exact request id decides
                }
            }
            if accepts(token), let value = try? await readCurrent(token) { apply(value, resetDraft: pendingSettings == nil) }
        }
    }
}
#endif
