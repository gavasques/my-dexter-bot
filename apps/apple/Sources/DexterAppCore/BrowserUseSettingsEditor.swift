#if os(macOS)
import DexterHostClient
import Foundation
import Observation

/// Owner-local preferences with a revision fence. This editor never holds provider credentials.
@MainActor @Observable public final class BrowserUseSettingsEditor {
    public enum Notice: Equatable, Sendable { case loadFailed, hostChanged, conflict, saveUnknown, saved }
    public let botID: String?
    public let session: SettingsEditorSession?
    public let hostScope: UUID
    public let hostAddress: String
    public private(set) var baseline: BrowserUseConfiguration?
    public private(set) var runtime: BrowserUseRuntimeStatus?
    public private(set) var busy = false
    public private(set) var requiresReload = false
    public private(set) var notice: Notice?
    public var enabled = false
    public var policy = BrowserUseBotPolicy()
    @ObservationIgnored private let model: DexterAppModel
    @ObservationIgnored private let clientFactory: (@MainActor () -> HostClient?)?
    @ObservationIgnored private var client: HostClient?
    @ObservationIgnored private var active = true
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var requestTask: Task<Void, Never>?

    public init(model: DexterAppModel, botID: String? = nil, clientFactory: (@MainActor () -> HostClient?)? = nil,
                session: SettingsEditorSession? = nil) {
        self.model = model; self.botID = botID; self.clientFactory = clientFactory; self.session = session
        hostScope = session?.hostScope ?? model.nativeComposerScope; hostAddress = session?.hostAddress ?? model.hostAddress
    }
    public var scopeMatches: Bool {
        let sessionMatches = session.map { $0.botID != nil && $0.botID == botID && $0.isCurrent(in: model) } ?? true
        return active && sessionMatches && hostScope == model.nativeComposerScope && hostAddress == model.hostAddress && model.canEditBotProfiles &&
        (baseline.map { $0.hostID == model.browserUseHostID } ?? true)
    }
    public var dirty: Bool {
        guard let baseline else { return false }
        if let botID { return policy != (baseline.bots[botID] ?? BrowserUseBotPolicy()) }
        return enabled != baseline.enabled
    }
    public var canEdit: Bool { scopeMatches && baseline != nil && !busy && !requiresReload }
    public var canSave: Bool { canEdit && dirty && (botID == nil || policy.isValid) }
    public func openIfNeeded() { guard active, client == nil, baseline == nil, !busy else { return }; reload() }
    public func close(clearDrafts: Bool = false) {
        generation = UUID(); active = false; requestTask?.cancel(); requestTask = nil
        client?.close(); client = nil; busy = false; runtime = nil
        if clearDrafts { baseline = nil; policy = BrowserUseBotPolicy(); enabled = false; requiresReload = true; notice = .hostChanged }
    }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }
    public func reload() {
        guard scopeMatches, !busy else { return }
        if client == nil { client = clientFactory?() ?? model.makeLocalMcpClient() }
        guard let client else { requiresReload = true; notice = .loadFailed; return }
        // A supplied scoped client must belong to the immutable window target, never a later model address.
        guard session == nil || DexterAppStateValidation.validatedLoopbackAddress(client.baseURL.absoluteString)
            == DexterAppStateValidation.validatedLoopbackAddress(hostAddress) else {
            requiresReload = true; notice = .hostChanged; return
        }
        let token = generation
        busy = true; notice = nil
        requestTask = Task { @MainActor in
            defer { if token == generation { busy = false; requestTask = nil } }
            do {
                // The task may start after a base switch, even though reload() passed its synchronous guard.
                guard accepts(token) else { return }
                let value = try await client.browserUseConfiguration()
                guard accepts(token) else { return }
                guard value.hostID == model.browserUseHostID else { throw HostClientError.contractMismatch }
                baseline = value; enabled = value.enabled
                if let botID { policy = value.bots[botID] ?? BrowserUseBotPolicy() }
                requiresReload = false
                guard accepts(token) else { return }
                let status = try? await client.browserUseStatus()
                guard accepts(token) else { return }
                runtime = status?.hostID == value.hostID ? status : nil
            } catch {
                guard accepts(token) else { return }; requiresReload = true; notice = .loadFailed
            }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }
    public func refreshRuntime() async {
        guard scopeMatches, let client, let hostID = baseline?.hostID else { return }
        let token = generation
        let status = try? await client.browserUseStatus()
        guard accepts(token) else { return }
        runtime = status?.hostID == hostID ? status : nil
    }
    /// Awaitable forms for the guided Connect flow; each still sends at most the one request of `reload()`/`save()`.
    public func reloadAndWait() async { reload(); await requestTask?.value }
    public func saveAndWait() async { save(); await requestTask?.value }
    private func retainUncertainMutation(_ token: UUID) {
        guard active, token == generation else { return }
        requiresReload = true; notice = .saveUnknown
    }
    public func save() {
        guard canSave, let baseline, let client else { return }
        var bots = baseline.bots
        if let botID { bots[botID] = policy }
        let nextEnabled = botID == nil ? enabled : baseline.enabled
        let token = generation
        busy = true; notice = nil
        requestTask = Task { @MainActor in
            defer { if token == generation { busy = false; requestTask = nil } }
            do {
                guard accepts(token) else { return }
                let value = try await client.updateBrowserUseConfiguration(hostID: baseline.hostID,
                    expectedRevision: baseline.revision, enabled: nextEnabled, bots: bots)
                guard accepts(token) else { retainUncertainMutation(token); return }
                self.baseline = value; enabled = value.enabled
                if let botID { policy = value.bots[botID] ?? BrowserUseBotPolicy() }
                notice = .saved
                await refreshRuntime()
            } catch {
                guard accepts(token) else { retainUncertainMutation(token); return }
                requiresReload = true; notice = (error as? HostClientError) == .conflict ? .conflict : .saveUnknown
            }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }
}

// MARK: - Connection (UX-P0-03)

/// Private delivery of the Browser Use key to the base this app started on this Mac. A paired or remote base, or a
/// loopback process started by someone else, has no bridge: a local key is never sent there.
@MainActor public protocol BrowserUseKeyBridge: AnyObject {
    /// Lifetime of the owned child that can receive a key for `hostID` now; nil when delivery is impossible.
    func deliveryLifetime(hostID: String) -> UUID?
    func deliver(_ key: String?, hostID: String) async throws
}

@MainActor public final class LocalHostBrowserUseKeyBridge: BrowserUseKeyBridge {
    private weak var coordinator: LocalHostLaunchCoordinator?
    private weak var model: DexterAppModel?
    public init(coordinator: LocalHostLaunchCoordinator?, model: DexterAppModel) { self.coordinator = coordinator; self.model = model }
    public func deliveryLifetime(hostID: String) -> UUID? {
        guard let coordinator, let model, coordinator.canManageBrowserUseKey(model: model, hostID: hostID) else { return nil }
        return coordinator.supervisor?.memoryBackendLifetime
    }
    public func deliver(_ key: String?, hostID: String) async throws {
        guard let coordinator, let model else { throw BrowserUseKeyFailure.bridgeUnavailable }
        try await coordinator.setBrowserUseKey(key, model: model, hostID: hostID)
    }
}

/// In-memory marks for one host child lifetime: an explicit pause, or a delivery whose acknowledgement was lost. A new
/// child (restart) starts clean; nothing here is persisted or holds the key.
@MainActor public final class BrowserUseCustodyLedger {
    public enum Mark: Equatable, Sendable { case paused, uncertain }
    private struct Key: Hashable { let hostID: String; let lifetime: UUID }
    public static let shared = BrowserUseCustodyLedger()
    private var marks: [Key: Mark] = [:]
    public init() {}
    public func mark(hostID: String, lifetime: UUID?) -> Mark? { lifetime.flatMap { marks[Key(hostID: hostID, lifetime: $0)] } }
    public func set(_ mark: Mark?, hostID: String, lifetime: UUID) {
        let key = Key(hostID: hostID, lifetime: lifetime)
        if let mark { marks[key] = mark } else { marks.removeValue(forKey: key) }
        if marks.count > 64 { marks = marks.filter { $0.key == key } }
    }
}

/// The one state the Browser Use card shows, with one main action each.
public enum BrowserUseConnectionState: Equatable, Sendable {
    case checking
    /// Not the owner's base on this Mac (paired/remote, or a process this app did not start): no local key custody.
    case unavailableHere
    case storageUnavailable
    case notConnected
    /// Key saved on this Mac, the base's in-memory connection is locked (expired or host restarted).
    case needsReconnect
    /// Locked by an explicit Pausar in this app, for this host child.
    case paused
    /// A step could not be confirmed (lost acknowledgement, unreadable status): read before anything else.
    case cannotConfirm
    case needsEnable
    case connected

    public static func derive(ownerLocal: Bool, canDeliver: Bool, keyStatus: BrowserUseKeyStatus,
                              configuration: BrowserUseConfiguration?, runtime: BrowserUseRuntimeStatus?,
                              loadFailed: Bool, mark: BrowserUseCustodyLedger.Mark?) -> BrowserUseConnectionState {
        guard ownerLocal else { return .unavailableHere }
        guard let configuration else { return loadFailed ? .cannotConfirm : .checking }
        // An unlocked status is a confirmed host fact, whatever the local marks say.
        if let runtime, runtime.credential.unlocked { return configuration.enabled ? .connected : .needsEnable }
        guard canDeliver else { return .unavailableHere }
        switch keyStatus {
        case .unavailable: return .storageUnavailable
        case .missing: return mark == .uncertain ? .cannotConfirm : .notConnected
        case .configured: break
        }
        if mark == .uncertain || runtime == nil { return .cannotConfirm }
        return mark == .paused ? .paused : .needsReconnect
    }
}

/// Guided Connect, Reconectar, Ativar, Conferir, Pausar and Desconectar. Each step is confirmed on its own; there is no
/// transaction or rollback across Keychain, the private channel and the host configuration, and nothing is re-sent.
@MainActor @Observable public final class BrowserUseConnectionController {
    public enum Step: String, CaseIterable, Sendable { case keySaved, delivered, enabled }
    public enum StepState: Equatable, Sendable { case pending, running, confirmed, alreadyDone, failed, uncertain }
    public enum Outcome: Equatable, Sendable {
        case connected, reconnected, enabled, paused, disconnected, checked
        case notThisMac, invalidKey, storageFailed, deliveryFailed
        case deliveryUnconfirmed, enableConflict, enableUnconfirmed, lockUnconfirmed
    }
    public let editor: BrowserUseSettingsEditor
    public private(set) var steps: [Step: StepState] = [:]
    public private(set) var busy = false
    public private(set) var keyStatus: BrowserUseKeyStatus = .missing
    public private(set) var outcome: Outcome?
    @ObservationIgnored private let model: DexterAppModel
    @ObservationIgnored private let keyStore: any BrowserUseAPIKeyStore
    @ObservationIgnored private let bridge: (any BrowserUseKeyBridge)?
    @ObservationIgnored private let ledger: BrowserUseCustodyLedger
    /// Bumped on every local mark change so the derived state re-renders.
    private var markRevision = 0

    public init(model: DexterAppModel, editor: BrowserUseSettingsEditor, keyStore: any BrowserUseAPIKeyStore,
                bridge: (any BrowserUseKeyBridge)?, ledger: BrowserUseCustodyLedger = .shared) {
        self.model = model; self.editor = editor; self.keyStore = keyStore; self.bridge = bridge; self.ledger = ledger
    }

    private var hostID: String? { editor.baseline?.hostID }
    private var lifetime: UUID? { hostID.flatMap { bridge?.deliveryLifetime(hostID: $0) } }
    public var canDeliver: Bool { lifetime != nil }
    public var mark: BrowserUseCustodyLedger.Mark? { _ = markRevision; return hostID.flatMap { ledger.mark(hostID: $0, lifetime: lifetime) } }

    public var state: BrowserUseConnectionState {
        BrowserUseConnectionState.derive(ownerLocal: model.canEditBotProfiles, canDeliver: canDeliver, keyStatus: keyStatus,
            configuration: editor.baseline, runtime: editor.runtime, loadFailed: editor.notice == .loadFailed && editor.baseline == nil, mark: mark)
    }

    public func refreshKeyStatus() { keyStatus = hostID.map { keyStore.status(hostID: $0) } ?? .missing }

    private func setMark(_ value: BrowserUseCustodyLedger.Mark?) {
        guard let hostID, let lifetime else { return }
        ledger.set(value, hostID: hostID, lifetime: lifetime); markRevision &+= 1
    }

    private func begin() -> Bool {
        guard !busy, editor.scopeMatches else { return false }
        busy = true; outcome = nil; return true
    }

    /// Conectar: save the key here, deliver it to this Mac's base, then enable the base setting by its revision.
    public func connect(key rawKey: String) async {
        guard begin() else { return }
        defer { busy = false; refreshKeyStatus() }
        steps = [.keySaved: .pending, .delivered: .pending, .enabled: .pending]
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hostID, canDeliver else { steps[.keySaved] = .failed; outcome = .notThisMac; return }
        guard BrowserUseKeyValidation.isValid(key) else { steps[.keySaved] = .failed; outcome = .invalidKey; return }
        steps[.keySaved] = .running
        do { try keyStore.save(key, hostID: hostID) } catch { steps[.keySaved] = .failed; outcome = .storageFailed; return }
        guard keyStore.status(hostID: hostID) == .configured else { steps[.keySaved] = .failed; outcome = .storageFailed; return }
        steps[.keySaved] = .confirmed
        guard await deliverAndConfirm(key, hostID: hostID) else { return }
        await enableConfirmed()
        if steps[.enabled] == .confirmed || steps[.enabled] == .alreadyDone { outcome = .connected }
    }

    /// Reconectar: the saved key again, through the private channel of the current child only.
    public func reconnect() async {
        guard begin() else { return }
        defer { busy = false; refreshKeyStatus() }
        steps = [.delivered: .pending]
        guard let hostID, canDeliver else { outcome = .notThisMac; return }
        let key: String
        do { key = try keyStore.load(hostID: hostID) } catch { steps[.delivered] = .failed; outcome = .storageFailed; return }
        if await deliverAndConfirm(key, hostID: hostID) { outcome = .reconnected }
    }

    /// Ativar: one revision-checked write of the base setting. A conflict is re-read, never re-sent.
    public func enable() async {
        guard begin() else { return }
        defer { busy = false }
        steps = [.enabled: .pending]
        await enableConfirmed()
        if steps[.enabled] == .confirmed || steps[.enabled] == .alreadyDone { outcome = .enabled }
    }

    /// Conferir: reads only. Clears a lost-acknowledgement mark when the base confirms an unlocked connection.
    public func check() async {
        guard begin() else { return }
        defer { busy = false; refreshKeyStatus() }
        await editor.reloadAndWait()
        if editor.runtime?.credential.unlocked == true, mark == .uncertain { setMark(nil) }
        outcome = .checked
    }

    /// Pausar: locks the base's in-memory connection. The key stays saved on this Mac.
    public func pause() async {
        guard begin() else { return }
        defer { busy = false; refreshKeyStatus() }
        guard let hostID, canDeliver else { outcome = .notThisMac; return }
        do { try await bridge?.deliver(nil, hostID: hostID) } catch { outcome = .lockUnconfirmed; return }
        await editor.refreshRuntime()
        guard editor.runtime?.credential.unlocked == false else { outcome = .lockUnconfirmed; return }
        setMark(.paused); outcome = .paused
    }

    /// Desconectar: lock first; only a confirmed lock removes the key from this Mac. Other bases are untouched.
    public func disconnect() async {
        guard begin() else { return }
        defer { busy = false; refreshKeyStatus() }
        guard let hostID, canDeliver else { outcome = .notThisMac; return }
        do { try await bridge?.deliver(nil, hostID: hostID) } catch { outcome = .lockUnconfirmed; return }
        await editor.refreshRuntime()
        guard editor.runtime?.credential.unlocked == false else { outcome = .lockUnconfirmed; return }
        do { try keyStore.remove(hostID: hostID) } catch { outcome = .storageFailed; return }
        setMark(nil); outcome = .disconnected
    }

    private func deliverAndConfirm(_ key: String, hostID: String) async -> Bool {
        steps[.delivered] = .running
        let child = lifetime
        do { try await bridge?.deliver(key, hostID: hostID) }
        catch BrowserUseKeyFailure.bridgeUnconfirmed {
            steps[.delivered] = .uncertain; setMark(.uncertain); outcome = .deliveryUnconfirmed; return false
        } catch {
            steps[.delivered] = .failed; outcome = .deliveryFailed; return false
        }
        await editor.refreshRuntime()
        guard lifetime == child, editor.runtime?.credential.unlocked == true else {
            steps[.delivered] = .uncertain; setMark(.uncertain); outcome = .deliveryUnconfirmed; return false
        }
        steps[.delivered] = .confirmed; setMark(nil); return true
    }

    private func enableConfirmed() async {
        steps[.enabled] = .running
        guard let baseline = editor.baseline else { steps[.enabled] = .failed; outcome = .enableUnconfirmed; return }
        if baseline.enabled { steps[.enabled] = .alreadyDone; return }
        editor.enabled = true
        await editor.saveAndWait()
        switch editor.notice {
        case .saved? where editor.baseline?.enabled == true:
            steps[.enabled] = .confirmed
        case .conflict?:
            await editor.reloadAndWait()
            if editor.baseline?.enabled == true { steps[.enabled] = .alreadyDone } else { steps[.enabled] = .failed; outcome = .enableConflict }
        default:
            await editor.reloadAndWait()
            if editor.baseline?.enabled == true { steps[.enabled] = .confirmed } else { steps[.enabled] = .uncertain; outcome = .enableUnconfirmed }
        }
    }
}

/// Root decision (ux-primeiro-uso-conexoes-2026-10-12): reconnect on the owner's Permitir of a Browser Use action,
/// before the existing decision is sent. It belongs to that action, tool, bot, thread and host child; a paired or remote
/// base never receives a local key; a paused or unconfirmed connection is not reopened silently.
@MainActor public final class BrowserUseApprovalPreflight {
    public static let tool = "dexter.browseruse.run"
    public enum Refusal: Equatable, Sendable { case paused, uncertain, noKey, storageUnavailable, reconnectFailed, changed }
    public enum Outcome: Equatable, Sendable { case proceed, refused(Refusal) }
    private let model: DexterAppModel
    private let bridge: (any BrowserUseKeyBridge)?
    private let keyStore: any BrowserUseAPIKeyStore
    private let ledger: BrowserUseCustodyLedger
    private let clientFactory: @MainActor () -> HostClient?

    public init(model: DexterAppModel, bridge: (any BrowserUseKeyBridge)?, keyStore: any BrowserUseAPIKeyStore,
                ledger: BrowserUseCustodyLedger = .shared, clientFactory: (@MainActor () -> HostClient?)? = nil) {
        self.model = model; self.bridge = bridge; self.keyStore = keyStore; self.ledger = ledger
        self.clientFactory = clientFactory ?? { [weak model] in model?.makeLocalMcpClient() }
    }

    public static func applies(to action: Action) -> Bool { action.request.tool == tool && action.state == .awaitingApproval }

    public func prepare(_ action: Action, threadID: String) async -> Outcome {
        guard Self.applies(to: action), action.request.threadId == threadID, model.canEditBotProfiles,
              let hostID = model.browserUseHostID, let bridge, let child = bridge.deliveryLifetime(hostID: hostID) else { return .proceed }
        let scope = model.nativeComposerScope, address = model.hostAddress, botID = action.request.botId, actionID = action.id
        func current() -> Bool {
            model.nativeComposerScope == scope && model.hostAddress == address && model.browserUseHostID == hostID
                && model.selectedBotID == botID && model.selectedThreadID == threadID
                && model.actions(for: threadID).first(where: { $0.id == actionID })?.state == .awaitingApproval
                && bridge.deliveryLifetime(hostID: hostID) == child
        }
        func unlocked() async -> Bool? {
            guard let client = clientFactory() else { return nil }
            defer { client.close() }
            guard let status = try? await client.browserUseStatus(), status.hostID == hostID else { return nil }
            return status.credential.unlocked
        }
        // Unreadable status: the existing decision goes as before and the base reports its own state.
        guard let open = await unlocked() else { return current() ? .proceed : .refused(.changed) }
        guard current() else { return .refused(.changed) }
        if open {
            if ledger.mark(hostID: hostID, lifetime: child) == .uncertain { ledger.set(nil, hostID: hostID, lifetime: child) }
            return .proceed
        }
        switch ledger.mark(hostID: hostID, lifetime: child) {
        case .paused?: return .refused(.paused)
        case .uncertain?: return .refused(.uncertain)
        case nil: break
        }
        switch keyStore.status(hostID: hostID) {
        case .missing: return .refused(.noKey)
        case .unavailable: return .refused(.storageUnavailable)
        case .configured: break
        }
        let key: String
        do { key = try keyStore.load(hostID: hostID) } catch { return .refused(.storageUnavailable) }
        guard current() else { return .refused(.changed) }
        do { try await bridge.deliver(key, hostID: hostID) }
        catch BrowserUseKeyFailure.bridgeUnconfirmed { ledger.set(.uncertain, hostID: hostID, lifetime: child); return .refused(.uncertain) }
        catch { return .refused(.reconnectFailed) }
        guard current() else { return .refused(.changed) }
        guard await unlocked() == true else { ledger.set(.uncertain, hostID: hostID, lifetime: child); return .refused(.uncertain) }
        return current() ? .proceed : .refused(.changed)
    }
}
#endif
