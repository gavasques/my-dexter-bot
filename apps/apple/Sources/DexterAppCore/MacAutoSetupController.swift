#if os(macOS)
import AppKit
import CryptoKit
import Darwin
import DexterHostClient
import Foundation
import Observation

/// Human-only preparation of THIS app's own Mac executor. TCC and lock calibration stay in the
/// helper's physical panel. A prepared directory, live process or offered capability is not a grant.
@Observable @MainActor
public final class MacAutoSetupController {
    public enum Phase: Equatable { case idle, ready, preparing, awaitingApproval, checking, connected, unconfirmed, blocked(String) }
    public private(set) var phase: Phase = .idle
    public private(set) var fingerprint: String?
    public private(set) var pendingCreationID: String?
    public private(set) var deviceID: String?
    public private(set) var panelNotice: String?
    public enum Stage: String, Equatable, Sendable { case inspection, channel, configuration, identity, agent, claim, approval, presence }
    public private(set) var stage: Stage = .inspection
    /// Closed, value-free recovery text. The first-run flow may display this without reading custody.
    public private(set) var preparationDetail: String?
    public var isWorking: Bool { [.preparing, .checking].contains(phase) }
    public var isUnconfirmed: Bool { phase == .unconfirmed }
    public var canReconnect: Bool {
        !isWorking && current() && !agent.ownsLiveChild && deviceID != nil && fingerprint != nil && selection?.hasSavedPairing == true
    }
    @ObservationIgnored private let model: DexterAppModel
    @ObservationIgnored private let host: LocalHostLaunchCoordinator
    @ObservationIgnored private let agent: LocalMacAgentProcess
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let location: LocalMacAgentSetupLocation
    @ObservationIgnored private let helper: LocalMacAgentHelperPackage
    @ObservationIgnored private let cua: LocalMacAgentCuaPackage
    @ObservationIgnored private let launch: LocalMacAgentLaunchConfiguration
    @ObservationIgnored private let scope: String
    @ObservationIgnored private let installation: String
    @ObservationIgnored private var expectedPreference: LocalEngineStoredPreference
    @ObservationIgnored private var selection: LocalMacAgentSelection?
    @ObservationIgnored private var claim: LocalMacAgentClaim?
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var operation: Task<Void, Never>?
    @ObservationIgnored private var approvalAttempted = false

    init(model: DexterAppModel, host: LocalHostLaunchCoordinator, agent: LocalMacAgentProcess, client: HostClient,
         location: LocalMacAgentSetupLocation, helper: LocalMacAgentHelperPackage, cua: LocalMacAgentCuaPackage,
         launch: LocalMacAgentLaunchConfiguration) {
        self.model = model; self.host = host; self.agent = agent; self.client = client
        self.location = location; self.helper = helper; self.cua = cua; self.launch = launch
        scope = model.filesScope; installation = model.browserUseHostID ?? ""
        expectedPreference = host.loadLocalEnginePreference()
    }
    private func current() -> Bool {
        opened && !Task.isCancelled && model.filesScope == scope && model.browserUseHostID == installation
            && model.isOnline && host.confirmedOwnedHostID == installation && host.loadLocalEnginePreference() == expectedPreference
            && host.localRuntimeSetupRefusal(model: model) == nil
    }
    private func requireCurrent() throws { guard current() else { throw LocalHostUnlockFailure.scopeMismatch } }

    /// Inspection only: no host mutation, identity helper, Keychain value, launch or permission request.
    public func open() {
        opened = true
        guard !isWorking else { return }
        do {
            try requireCurrent(); pendingCreationID = host.pendingDeviceChannelCreationID()
            switch LocalMacAgentSetup.inspect(location) {
            case .conflict: throw LocalMacAgentSetupError.conflict
            case .notPrepared: phase = .ready
            case .prepared(let existing):
                selection = existing
                _ = try LocalMacAgentPolicy.read(selection: existing, expectedInstallationID: installation)
                if let receipt = try LocalMacAgentSetup.reconcileEndpointRebind(location: location), receipt.state != .committed {
                    phase = .unconfirmed; return
                }
                try restorePublicCorrelation(existing)
                if approvalAttempted || fingerprint != nil || existing.hasSavedPairing {
                    stage = .presence; phase = .unconfirmed
                    preparationDetail = String(localized: "Há uma preparação existente. Confira a conexão original; nenhuma identidade, aprovação ou permissão será refeita.")
                } else if phase != .awaitingApproval { phase = .ready }
            }
        } catch { phase = .blocked(Self.message(error)) }
    }

    /// Explicit owner gesture: prepare channel/config, load the identity (create only on proven missing),
    /// and start the owned daemon with the same CUA transport. No bot receives access.
    public func prepare() {
        guard phase == .ready, current() else { return }
        phase = .preparing; preparationDetail = nil
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                try requireCurrent()
                switch LocalMacAgentSetup.inspect(location) {
                case .conflict: throw LocalMacAgentSetupError.conflict
                case .prepared(let existing):
                    guard existing.capabilities.count == 3, Set(existing.capabilities) == Set(LocalMacAgentCuaOnlySetupCapabilities.values) else { throw LocalMacAgentSetupError.conflict }
                case .notPrepared: break
                }
                if agent.ownsLiveChild { try await agent.stop(); try requireCurrent() }
                stage = .channel
                try await host.prepareDeviceChannel(model: model, resumeCreationID: pendingCreationID, isCurrent: { [weak self] in
                    guard let self else { return false }; return self.opened && self.model.filesScope == self.scope && self.model.browserUseHostID == self.installation
                })
                guard opened, model.filesScope == scope, model.browserUseHostID == installation else { throw LocalHostUnlockFailure.scopeMismatch }
                expectedPreference = host.loadLocalEnginePreference(); try requireCurrent()
                guard try await client.localMacAgentInstallationID() == installation else { throw HostClientError.contractMismatch }
                try requireCurrent()
                let envelope = try await client.localMacAgentSetupEnvelope(); try requireCurrent()
                let bundle = try LocalMacAgentSetupBundle(json: envelope, expectedInstallationID: installation)
                stage = .configuration
                var selected: LocalMacAgentSelection
                switch LocalMacAgentSetup.inspect(location) {
                case .conflict: throw LocalMacAgentSetupError.conflict
                case .notPrepared:
                    selected = try LocalMacAgentSetup.prepareCuaOnly(bundle: bundle, helper: helper, cuaPackage: cua,
                        location: location, name: "Dexter Mac")
                case .prepared(let existing):
                    let snapshot = try LocalMacAgentPolicy.read(selection: existing, expectedInstallationID: installation)
                    if existing.hostURL != bundle.offer.hostURL {
                        selected = try LocalMacAgentSetup.rebindEndpoint(bundle: bundle, selection: existing,
                            expectedSnapshot: snapshot, agentStopped: !agent.ownsLiveChild)
                    } else { selected = existing }
                }
                guard selected.capabilities.count == 3, Set(selected.capabilities) == Set(LocalMacAgentCuaOnlySetupCapabilities.values) else { throw LocalMacAgentSetupError.conflict }
                selection = selected; try requireCurrent()
                stage = .identity
                let identity = await LocalMacAgentSetup.loadIdentity(location: location, selection: selected, expectedInstallationID: installation)
                try requireCurrent()
                switch identity {
                case .usable(let value): fingerprint = value
                case .missing:
                    // The original reviewed Prepare gesture authorizes one creation in this exact scope.
                    fingerprint = try await LocalMacAgentSetup.provisionIdentity(location, isCurrent: { [weak self] in
                        guard let self else { return false }; return self.opened && self.model.filesScope == self.scope && self.model.browserUseHostID == self.installation
                    })
                    try requireCurrent()
                    guard case .usable(let confirmed) = await LocalMacAgentSetup.loadIdentity(location: location,
                        selection: selected, expectedInstallationID: installation), confirmed == fingerprint else { throw LocalMacAgentSetupError.identityUnavailable }
                case .blocked(let reason): throw reason
                }
                try requireCurrent()
                guard !bundle.offer.isExpired(), let fingerprint else { throw LocalMacAgentSetupError.offerExpired }
                _ = try LocalMacAgentPolicy.read(selection: selected, expectedInstallationID: installation)
                stage = .agent
                try agent.start(launch, selection: selected, pairing: selected.hasSavedPairing ? nil : bundle.offer.pairing, prepareCua: true)
                if selected.hasSavedPairing { await checkConnection(); return }
                stage = .claim
                // Bounded GET only; no periodic background scan and no approval of another claim.
                for _ in 0..<20 {
                    try requireCurrent(); agent.refresh()
                    guard agent.ownsLiveChild else { throw LocalMacAgentSetupError.identityUnavailable }
                    let candidates = try await client.localMacAgentClaims(); try requireCurrent()
                    if let exact = Self.exactClaim(candidates, fingerprint: fingerprint, capabilities: selected.capabilities) {
                        claim = exact; phase = .awaitingApproval; return
                    }
                    try await Task.sleep(for: .milliseconds(500))
                }
                markUnconfirmed()
            } catch {
                if opened {
                    pendingCreationID = host.pendingDeviceChannelCreationID()
                    if error is CancellationError || (error as? HostClientError) == .mutationOutcomeUnknown {
                        markUnconfirmed()
                    } else { phase = .blocked(Self.message(error)); preparationDetail = Self.message(error) }
                }
            }
        }
    }

    /// One reviewed exact claim. Persist public intent BEFORE POST so a lost reply/relaunch cannot replay it.
    public func approve() {
        guard phase == .awaitingApproval, !approvalAttempted, current(), let claim, let selection, let fingerprint,
              Self.exactClaim([claim], fingerprint: fingerprint, capabilities: selection.capabilities) == claim else { return }
        phase = .checking; stage = .approval; preparationDetail = nil
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                try requireCurrent()
                let fresh = try await client.localMacAgentClaims(); try requireCurrent()
                guard Self.exactClaim(fresh, fingerprint: fingerprint, capabilities: selection.capabilities) == claim else { throw HostClientError.contractMismatch }
                _ = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installation)
                try MacAutoApprovalIntent(claimID: claim.claimId, installation: installation, fingerprint: fingerprint,
                    capabilities: selection.capabilities, root: location.root.path).save(location: location)
                approvalAttempted = true
                let approved = try await client.approveLocalMacAgentClaim(claim); try requireCurrent()
                deviceID = approved.deviceId
                await checkConnection()
            } catch { if opened { if approvalAttempted { markUnconfirmed() } else { phase = .blocked(Self.message(error)) } } }
        }
    }

    /// Read-only recovery. GET/presence and public local binding only; never repeats POST, provisioning or start.
    public func reconcile() {
        guard !isWorking, current() else { return }
        phase = .checking; preparationDetail = nil
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                try requireCurrent()
                guard case .prepared(let existing) = LocalMacAgentSetup.inspect(location) else { throw LocalMacAgentSetupError.conflict }
                selection = existing
                try restorePublicCorrelation(existing)
                // Reconciliation authenticates the selected installation and its existing public TLS pin.
                // It never asks for a new offer, starts a helper, loads a key or sends approval again.
                let connection = try await client.localMacAgentConnection(); try requireCurrent()
                try MacAutoSetupPublicObservation.requireConnection(connection, location: location, selection: existing, installation: installation)
                if let receipt = try LocalMacAgentSetup.reconcileEndpointRebind(location: location), receipt.state != .committed {
                    markUnconfirmed(); return
                }
                if !approvalAttempted, !existing.hasSavedPairing, let fingerprint, let selection {
                    let claims = try await client.localMacAgentClaims(); try requireCurrent()
                    if let exact = Self.exactClaim(claims, fingerprint: fingerprint, capabilities: selection.capabilities) {
                        claim = exact; phase = .awaitingApproval; return
                    }
                }
                await checkConnection()
            } catch { if opened { markUnconfirmed() } }
        }
    }
    private func checkConnection() async {
        stage = .presence
        do {
            for _ in 0..<20 {
                try requireCurrent(); agent.refresh()
                if let id = try boundDeviceID() {
                    // A failed model refresh intentionally retains its last projection. Never use
                    // that cached "online" row to certify a new preparation/read after a failed GET.
                    let devices = try await client.listDevices(); try requireCurrent()
                    if let device = devices.first(where: { $0.id == id }), device.paired, device.role == "agent-mac",
                       device.presence == .online, device.revokedAt == nil,
                       Set(selection?.capabilities ?? []).isSubset(of: Set(device.capabilities)) {
                        deviceID = id; phase = .connected; preparationDetail = nil; return
                    }
                }
                try await Task.sleep(for: .milliseconds(500))
            }
            markUnconfirmed()
        } catch { if opened { markUnconfirmed() } }
    }
    private func restorePublicCorrelation(_ existing: LocalMacAgentSelection) throws {
        _ = try LocalMacAgentPolicy.read(selection: existing, expectedInstallationID: installation)
        let observation = try MacAutoSetupPublicObservation.read(location: location, installation: installation)
        let intent = try MacAutoApprovalIntent.read(location: location, installation: installation)
        let restored = try observation.correlatedFingerprint(expected: fingerprint, intent: intent)
        fingerprint = restored
        if intent != nil { approvalAttempted = true }
        if let observedID = observation.deviceID {
            guard deviceID == nil || deviceID == observedID else { throw LocalMacAgentSetupError.conflict }
            deviceID = observedID
        }
    }
    private func markUnconfirmed() {
        phase = .unconfirmed
        switch stage {
        case .identity:
            preparationDetail = String(localized: "A identidade privada ainda não foi confirmada. Confira pelo fluxo privado; nenhuma chave será criada novamente por esta consulta.")
        case .agent, .claim:
            preparationDetail = String(localized: "O pedido de conexão deste auxiliar ainda não apareceu. Conferir procura somente o pedido original; não inicia outro auxiliar nem repete a preparação.")
        case .approval:
            preparationDetail = String(localized: "A resposta à aprovação não foi confirmada. Conferir consulta o vínculo e a presença deste Mac; a aprovação original não será reenviada.")
        default:
            preparationDetail = String(localized: "A base ainda não confirmou este Mac online. Conferir consulta a conexão original. Pareamento, acesso do bot e permissões do macOS são etapas separadas.")
        }
    }
    private func boundDeviceID() throws -> String? {
        let url = location.dataDirectory.appendingPathComponent("binding.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let object = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(url, maximum: 16384)) as? [String: Any]
        let helper = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(location.helperConfiguration, maximum: 32768)) as? [String: Any]
        let native = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(location.dataDirectory.appendingPathComponent("native-device.json"), maximum: 16384)) as? [String: Any]
        guard Set(object?.keys.map { $0 } ?? []) == ["installationId", "ownerId", "deviceId", "hostFingerprint"],
              object?["installationId"] as? String == installation,
              object?["hostFingerprint"] as? String == helper?["hostFingerprint"] as? String,
              native?["fingerprint"] as? String == fingerprint,
              let id = object?["deviceId"] as? String, id.range(of: LocalMacAgentSetup.wireID, options: .regularExpression) != nil,
              deviceID == nil || deviceID == id else { throw LocalMacAgentSetupError.conflict }
        return id
    }
    static func exactClaim(_ claims: [LocalMacAgentClaim], fingerprint: String, capabilities: [String], now: Date = Date()) -> LocalMacAgentClaim? {
        let exact = claims.filter { $0.kind == "pair" && $0.deviceId == nil && $0.clientFingerprint == fingerprint
            && $0.expiry > now && $0.capabilities.count == capabilities.count && Set($0.capabilities) == Set(capabilities) }
        return exact.count == 1 ? exact[0] : nil
    }
    /// Activate only the already-running, exact staged helper. Never launch a second transport or grant TCC.
    public func showControlPanel() {
        guard current(), let selection,
              (try? LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installation)) != nil else { return }
        guard LocalMacAgentCuaSetup.activateRunningHelper(location: location) else {
            panelNotice = String(localized: "O auxiliar ainda não abriu sua janela. Confira a conexão; nada foi iniciado novamente."); return
        }
        panelNotice = nil
    }
    /// Explicit human recovery of an already-bound executor. Not called by open/reconcile/startup.
    /// No offer, provisioning or approval POST; the signed helper only loads its existing identity.
    public func reconnect() {
        guard canReconnect, let selection, let fingerprint else { return }
        phase = .checking; stage = .agent; preparationDetail = nil
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                try requireCurrent()
                let connection = try await client.localMacAgentConnection(); try requireCurrent()
                try MacAutoSetupPublicObservation.requireConnection(connection, location: location, selection: selection, installation: installation)
                try restorePublicCorrelation(selection)
                guard try boundDeviceID() != nil else { throw LocalMacAgentSetupError.conflict }
                let identity = await LocalMacAgentSetup.loadIdentity(location: location, selection: selection, expectedInstallationID: installation)
                try requireCurrent()
                guard identity == .usable(fingerprint: fingerprint) else {
                    if case .blocked(let reason) = identity { throw reason }
                    throw LocalMacAgentSetupError.identityUnavailable
                }
                _ = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installation)
                try agent.start(launch, selection: selection, pairing: nil, prepareCua: true)
                await checkConnection()
            } catch { if opened { phase = .blocked(Self.message(error)); preparationDetail = Self.message(error) } }
        }
    }
    public func stop() {
        guard !isWorking else { return }
        phase = .checking
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                try requireCurrent(); guard host.pausePreparedMacAgent(model: model) else { throw LocalMacAgentSetupError.conflict }
                expectedPreference = host.loadLocalEnginePreference()
                try await agent.stop()
                if opened {
                    // Stopping never erases an immutable approval intent or turns an unknown POST
                    // into permission to issue a fresh setup request.
                    if approvalAttempted || fingerprint != nil || selection?.hasSavedPairing == true { markUnconfirmed() }
                    else { phase = .ready }
                }
            }
            catch { if opened { phase = .unconfirmed } }
        }
    }
    public func close() { opened = false; operation?.cancel(); operation = nil; claim = nil; if isWorking { phase = .unconfirmed } }
    static func message(_ error: Error) -> String {
        if let setup = error as? LocalMacAgentSetupError {
            switch setup {
            case .signingIdentityUnavailable: return message(LocalMacAgentIdentityBlockReason.signingIdentityUnavailable)
            case .identityPolicyUnavailable: return message(LocalMacAgentIdentityBlockReason.nonExportabilityUnconfirmed)
            case .identityExists, .conflict: return message(LocalMacAgentIdentityBlockReason.conflict)
            default: break
            }
        }
        if let reason = error as? LocalMacAgentIdentityBlockReason {
            switch reason {
            case .locked: return String(localized: "A identidade deste Mac está bloqueada. Desbloqueie o Mac e confira pelo fluxo privado; nenhuma chave foi substituída.")
            case .signingIdentityUnavailable: return String(localized: "O auxiliar não confirmou uma assinatura oficial válida. Use o pacote assinado do Dexter; nenhuma identidade foi criada ou substituída.")
            case .nonExportabilityUnconfirmed: return String(localized: "O macOS não confirmou a proteção exigida para a identidade deste Mac. A preparação foi bloqueada; não recrie a chave nem reduza a proteção.")
            case .conflict, .unsafeConfiguration: return String(localized: "A configuração ou identidade existente não corresponde a esta base. Confira os ajustes avançados; nada foi substituído.")
            default: return String(localized: "O auxiliar de identidade não confirmou a consulta. Confira o pacote assinado e a conexão pelo fluxo privado.")
            }
        }
        if let refusal = error as? LocalEngineApplyRefusal { return refusal.message }
        if let failure = error as? LocalHostUnlockFailure, failure == .legacyPasswordRequired {
            return String(localized: "Este Mac já tem um canal protegido por frase-senha. Desbloqueie-o nos ajustes avançados; nada foi substituído.")
        }
        return String(localized: "A preparação não foi concluída. Confira a assinatura, a conexão e os ajustes existentes; nada foi redefinido.")
    }
}

extension LocalMacAgentCuaSetup {
    /// Brings forward only the helper already running from this exact staged location. Never launches it, starts a
    /// second transport, opens System Settings or requests a macOS permission. False when it is not running.
    @MainActor public static func activateRunningHelper(location: LocalMacAgentSetupLocation) -> Bool {
        let exact = location.cuaApplication.resolvingSymlinksInPath()
        guard let application = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.resolvingSymlinksInPath() == exact }) else { return false }
        return application.activate(options: [.activateAllWindows])
    }
}

/// Immutable PUBLIC intention, not an authority token. Create-only and read-only reconciliation.
struct MacAutoApprovalIntent: Codable, Equatable {
    let schema: String
    let requestID: String, requestHash: String
    let claimID: String, installation: String, fingerprint: String
    let capabilities: [String]
    let root: String
    init(claimID: String, installation: String, fingerprint: String, capabilities: [String], root: String) {
        schema = "dexter.mac-auto-approval/1"; requestID = UUID().uuidString
        self.claimID = claimID; self.installation = installation; self.fingerprint = fingerprint
        self.capabilities = capabilities.sorted(); self.root = root
        requestHash = Self.hash(requestID: requestID, claimID: claimID, installation: installation, fingerprint: fingerprint, capabilities: self.capabilities, root: root)
    }
    private static let name = ".mac-auto-approval.json"
    private static func hash(requestID: String, claimID: String, installation: String, fingerprint: String, capabilities: [String], root: String) -> String {
        let material: [String: Any] = ["schema": "dexter.mac-auto-approval/1", "requestID": requestID, "claimID": claimID,
            "installation": installation, "fingerprint": fingerprint, "capabilities": capabilities, "root": root]
        let data = try! JSONSerialization.data(withJSONObject: material, options: [.sortedKeys, .withoutEscapingSlashes])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    func save(location: LocalMacAgentSetupLocation) throws {
        guard root == location.root.path, try Self.read(location: location, installation: installation) == nil else { throw LocalMacAgentSetupError.conflict }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(self)
        let dir = open(location.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard dir >= 0 else { throw LocalMacAgentSetupError.unsafeLocation }; defer { close(dir) }
        var info = stat(); guard fstat(dir, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw LocalMacAgentSetupError.unsafeLocation }
        let fd = openat(dir, Self.name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw LocalMacAgentSetupError.conflict }; defer { close(fd) }
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!, $0.count) }
        guard written == data.count, fsync(fd) == 0, fsync(dir) == 0 else { throw LocalMacAgentSetupError.writeFailed }
        guard try Self.read(location: location, installation: installation) == self else { throw LocalMacAgentSetupError.conflict }
    }
    static func read(location: LocalMacAgentSetupLocation, installation: String) throws -> Self? {
        let url = location.root.appendingPathComponent(name); var info = stat()
        guard lstat(url.path, &info) == 0 else { if errno == ENOENT { return nil }; throw LocalMacAgentSetupError.unsafeLocation }
        let data = try LocalMacAgentPolicy.privateRead(url, maximum: 16384)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard Set(object?.keys.map { $0 } ?? []) == ["schema", "requestID", "requestHash", "claimID", "installation", "fingerprint", "capabilities", "root"],
              object?["schema"] as? String == "dexter.mac-auto-approval/1" else { throw LocalMacAgentSetupError.conflict }
        let intent = try JSONDecoder().decode(Self.self, from: data)
        guard intent.schema == "dexter.mac-auto-approval/1", UUID(uuidString: intent.requestID) != nil,
              intent.requestHash == Self.hash(requestID: intent.requestID, claimID: intent.claimID, installation: intent.installation,
                fingerprint: intent.fingerprint, capabilities: intent.capabilities, root: intent.root),
              intent.root == location.root.path, intent.installation == installation,
              intent.claimID.range(of: LocalMacAgentSetup.wireID, options: .regularExpression) != nil,
              intent.fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              intent.capabilities == intent.capabilities.sorted(), Set(intent.capabilities) == Set(LocalMacAgentCuaOnlySetupCapabilities.values) else { throw LocalMacAgentSetupError.conflict }
        return intent
    }
}
private enum LocalMacAgentCuaOnlySetupCapabilities { static let values = ["mac.cua.status", "mac.cua.observe", "mac.cua.control"] }

/// Public startup correlation, never custody/readiness. Reopening a panel must not require a second
/// identity load just to recognize the fingerprint the daemon already recorded before its claim.
struct MacAutoSetupPublicObservation: Equatable {
    let fingerprint: String?
    let deviceID: String?

    static func read(location: LocalMacAgentSetupLocation, installation: String) throws -> Self {
        func document(_ url: URL, maximum: Int = 16384) throws -> [String: Any]? {
            var info = stat()
            guard lstat(url.path, &info) == 0 else {
                if errno == ENOENT { return nil }; throw LocalMacAgentSetupError.unsafeLocation
            }
            guard let object = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(url, maximum: maximum)) as? [String: Any] else {
                throw LocalMacAgentSetupError.conflict
            }
            return object
        }
        let native = try document(location.dataDirectory.appendingPathComponent("native-device.json"))
        let fingerprint = native?["fingerprint"] as? String
        if let native {
            guard Set(native.keys) == ["fingerprint"], let fingerprint,
                  LocalMacAgentSetup.matches(fingerprint, "^[a-f0-9]{64}$") else { throw LocalMacAgentSetupError.conflict }
        }
        let binding = try document(location.dataDirectory.appendingPathComponent("binding.json"))
        var deviceID: String?
        if let binding {
            let helper = try document(location.helperConfiguration, maximum: 32768)
            guard fingerprint != nil, Set(binding.keys) == ["installationId", "ownerId", "deviceId", "hostFingerprint"],
                  binding["installationId"] as? String == installation,
                  helper?["installationID"] as? String == installation,
                  let pin = helper?["hostFingerprint"] as? String, LocalMacAgentSetup.matches(pin, "^[a-f0-9]{64}$"),
                  binding["hostFingerprint"] as? String == pin,
                  let owner = binding["ownerId"] as? String, LocalMacAgentSetup.matches(owner, LocalMacAgentSetup.wireID),
                  let id = binding["deviceId"] as? String, LocalMacAgentSetup.matches(id, LocalMacAgentSetup.wireID) else {
                throw LocalMacAgentSetupError.conflict
            }
            deviceID = id
        }
        return Self(fingerprint: fingerprint, deviceID: deviceID)
    }
    func correlatedFingerprint(expected: String?, intent: MacAutoApprovalIntent?) throws -> String? {
        let pins = [fingerprint, expected, intent?.fingerprint].compactMap { $0 }
        guard Set(pins).count <= 1 else { throw LocalMacAgentSetupError.conflict }
        return pins.first
    }
    static func requireConnection(_ connection: LocalMacAgentConnectionDescription, location: LocalMacAgentSetupLocation,
                                  selection: LocalMacAgentSelection, installation: String) throws {
        let helper = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(location.helperConfiguration, maximum: 32768)) as? [String: Any]
        guard connection.installationID == installation, helper?["installationID"] as? String == installation,
              connection.hostURL == selection.hostURL, helper?["hostURL"] as? String == connection.hostURL,
              helper?["hostFingerprint"] as? String == connection.hostFingerprint,
              helper?["hostCertificateDER"] as? String == connection.certificateDER.base64EncodedString() else {
            throw LocalMacAgentSetupError.conflict
        }
    }
}
#endif
