#if os(macOS)
import AppKit
import CryptoKit
import DexterAssistantRuntimeSetup
import DexterHostClient
import Foundation
import Observation

/// Owner UI only. Installation receipts belong to the runtime service; engine choice belongs to the existing
/// coordinator. Neither a compatible executable nor an installation receipt proves login or a working conversation.
@Observable @MainActor
public final class AssistantSetupController {
    public enum Phase: Equatable {
        case idle, checking, ready, installing, applying, prepared, signingIn, signInFinished, unconfirmed
        case blocked(String)
    }
    public let engine: EngineID
    public private(set) var phase: Phase = .idle
    public private(set) var plan: SetupPlan?
    public private(set) var receipt: SetupReceipt?
    public private(set) var result: RuntimeSetupResult?
    public private(set) var progressStep: RuntimeSetupStep = .inspecting
    public enum Recovery: Equatable { case none, inspectAgain, prepareAgain, applyAgain, signInAgain, sameRequest }
    public private(set) var recovery: Recovery = .none
    @ObservationIgnored private let runtime: AssistantRuntimeSetup
    @ObservationIgnored private let model: DexterAppModel
    @ObservationIgnored private let host: LocalHostLaunchCoordinator
    @ObservationIgnored private let originalPreference: LocalEngineStoredPreference
    @ObservationIgnored private let scope: String
    @ObservationIgnored private var capture: SetupCapture
    @ObservationIgnored private var opened = true
    @ObservationIgnored private var operation: Task<Void, Never>?
    @ObservationIgnored private var signInProcess: Process?
    @ObservationIgnored private var applicationWasAttempted = false

    init(engine: EngineID, model: DexterAppModel, host: LocalHostLaunchCoordinator,
         runtime: AssistantRuntimeSetup, bundleID: String = Bundle.main.bundleIdentifier ?? "com.dexter.bot.mac") {
        self.engine = engine; self.model = model; self.host = host; self.runtime = runtime
        originalPreference = host.loadLocalEnginePreference(); scope = model.filesScope
        capture = SetupCapture(hostID: model.browserUseHostID ?? "", bundleID: bundleID,
            selectionGeneration: scope, windowID: model.nativeComposerScope.uuidString, requestID: UUID().uuidString)
    }

    public var hasOwnedLogin: Bool { signInProcess?.isRunning == true }
    public var isWorking: Bool { [.checking, .installing, .applying, .signingIn].contains(phase) }
    public var needsUnlock: Bool {
        guard let command = configurationCommand, let preference = try? Self.preference(originalPreference, engine: engine, command: command) else { return false }
        return host.needsDeviceChannelUnlock(preference)
    }
    public var targetVersion: String? { result?.version ?? plan?.reuseCandidate?.version ?? plan?.artifact?.version }
    public var willDownload: Bool { result == nil && plan?.action == .download }
    public var downloadBytes: Int64? { plan?.artifact?.expectedBytes }
    public var canUse: Bool { phase == .ready && plan != nil && current() }
    public var canRetry: Bool {
        guard !isWorking, phase != .unconfirmed, !hasOwnedLogin else { return false }
        switch recovery {
        case .none: return false
        case .signInAgain: return choiceIsApplied && !model.localRuntimeSetupBusy
        case .inspectAgain, .prepareAgain, .applyAgain, .sameRequest: return current()
        }
    }
    public var programIsPrepared: Bool { result != nil }
    public var choiceIsApplied: Bool {
        guard let command = configurationCommand,
              let preference = try? Self.preference(originalPreference, engine: engine, command: command) else { return false }
        return model.browserUseHostID == capture.hostID && host.isCurrentlyApplied(preference)
    }

    private var configurationCommand: String? {
        guard let result else { return nil }
        return plan?.reuseCandidate?.command ?? result.command
    }

    private var provider: AssistantProvider { engine == .claude ? .claude : .codex }
    private func current() -> Bool {
        opened && model.filesScope == scope && model.browserUseHostID == capture.hostID
            && host.loadLocalEnginePreference() == originalPreference && host.localRuntimeSetupRefusal(model: model) == nil
    }
    private func currentCapture() throws -> SetupCapture {
        guard current() else { throw SetupError.scopeChanged }; return capture
    }

    /// Opening performs bounded metadata inspection only. A recovered unknown receipt blocks any new installation.
    public func open() {
        opened = true
        guard phase == .idle else { return }
        guard [.claude, .codex].contains(engine), !capture.hostID.isEmpty, current() else {
            phase = .blocked(String(localized: "Conecte à base deste Mac e termine a atividade em andamento antes de preparar o assistente.")); return
        }
        guard originalPreference != .unreadable else {
            phase = .blocked(String(localized: "A escolha salva não pôde ser lida. Confira os ajustes antes de substituí-la.")); return
        }
        phase = .checking; recovery = .none
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                let pending = try await runtime.recoverableReceipts(provider: provider)
                guard current(), !Task.isCancelled else { throw SetupError.scopeChanged }
                if let pending = pending.first(where: { [.preparing, .unknown].contains($0.state) }) {
                    receipt = pending; phase = .unconfirmed; return
                }
                let selected: String? = { if case .saved(let p) = originalPreference { return p.path(for: LocalEngineKind(rawValue: engine.rawValue)!) }; return nil }()
                let prepared = try await runtime.prepare(capture: capture, provider: provider, preferredCommand: selected,
                    progress: { [weak self] step in await self?.updateProgress(step) })
                guard current(), !Task.isCancelled else { throw SetupError.scopeChanged }
                plan = prepared; phase = .ready
            } catch { if opened { recovery = current() ? .inspectAgain : .none; phase = .blocked(Self.message(error)) } }
        }
    }

    /// One exact human action. An uncertain receipt is read back; it never causes another install.
    public func use(unlockPassword: LocalHostUnlockPassword? = nil) {
        guard canUse, let plan else { unlockPassword?.clear(); return }
        phase = .installing; recovery = .none
        operation = Task { [weak self] in
            guard let self else { unlockPassword?.clear(); return }
            defer { unlockPassword?.clear() }
            do {
                let received: SetupReceipt
                if let receipt, receipt.state == .committed {
                    guard let checked = try await runtime.reconcile(requestID: receipt.requestID, requestHash: receipt.requestHash) else { throw SetupError.commitUnknown }
                    received = checked
                } else {
                received = try await runtime.install(plan: plan, currentCapture: { [weak self] in
                    guard let self else { throw SetupError.scopeChanged }
                    return try await self.currentCapture()
                }, progress: { [weak self] step in await self?.updateProgress(step) })
                }
                guard received.requestID == capture.requestID, received.requestHash == plan.requestHash else { throw SetupError.requestConflict }
                receipt = received
                guard opened else {
                    if [.failed, .cancelled].contains(received.state) {
                        recovery = .prepareAgain; phase = .blocked(Self.message(received.error ?? .cancelled))
                    }
                    return
                }
                switch received.state {
                case .committed:
                    guard let installed = received.result, current() else { throw SetupError.scopeChanged }
                    result = installed
                    let command = plan.reuseCandidate?.command ?? installed.command
                    guard Self.verifies(installed, launcher: command) else { throw SetupError.artifactChanged }
                    let preference = try Self.preference(originalPreference, engine: engine, command: command)
                    if host.needsDeviceChannelUnlock(preference), unlockPassword == nil {
                        // The installer has finished; the same verified receipt is used when the owner supplies the phrase.
                        phase = .ready; return
                    }
                    phase = .applying
                    applicationWasAttempted = true
                    let applied = await host.applyLocalEnginePreference(preference, model: model, unlockPassword: unlockPassword,
                        expectedPreference: originalPreference, verifyRuntime: { self.opened && self.model.filesScope == self.scope && self.model.browserUseHostID == self.capture.hostID && Self.verifies(installed, launcher: command) })
                    switch applied {
                    case .applied: phase = .prepared
                    case .refused(let refusal):
                        recovery = refusal.preferenceSaved ? .none : .applyAgain
                        phase = refusal.preferenceSaved ? .unconfirmed : .blocked(refusal.message)
                    case .idle, .applying: phase = .unconfirmed
                    }
                case .preparing, .unknown: phase = .unconfirmed
                case .cancelled: recovery = .prepareAgain; phase = .blocked(Self.message(SetupError.cancelled))
                case .failed: recovery = .prepareAgain; phase = .blocked(Self.message(received.error ?? SetupError.storageFailure))
                }
            } catch {
                if error as? SetupError == .busy {
                        // Lock contention refused this call before admission. A human retry keeps the same
                        // plan/ID/hash, so any journal written by an earlier call is still deduplicated.
                        receipt = nil; recovery = .sameRequest
                        phase = .blocked(String(localized: "Outra preparação está em andamento. Aguarde e tente novamente; o mesmo pedido será preservado."))
                } else if opened {
                    if error as? SetupError == .commitUnknown {
                        receipt = SetupReceipt(requestID: plan.capture.requestID, requestHash: plan.requestHash, state: .unknown)
                        phase = .unconfirmed
                    } else {
                        recovery = receipt?.state == .committed ? .applyAgain : (receipt == nil && current() ? .inspectAgain : .none)
                        phase = .blocked(Self.message(error))
                    }
                }
            }
        }
    }

    /// Receipt lookup only. Even a recovered commit does not apply preferences or start login automatically.
    public func reconcile() {
        guard !isWorking, let receipt else { return }
        phase = .checking; progressStep = .reconciling; recovery = .none
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                guard let checked = try await runtime.reconcile(requestID: receipt.requestID, requestHash: receipt.requestHash),
                      checked.requestID == receipt.requestID, checked.requestHash == receipt.requestHash else { throw SetupError.commitUnknown }
                guard opened else { return }
                self.receipt = checked
                if checked.state == .committed, let result = checked.result {
                    self.result = result
                    if applicationWasAttempted {
                        if let command = configurationCommand,
                           let preference = try? Self.preference(originalPreference, engine: engine, command: command),
                           host.isCurrentlyApplied(preference) { phase = .prepared }
                        else { phase = .blocked(String(localized: "O programa foi instalado, mas a aplicação à base não foi confirmada. Confira os assistentes ou reabra o Dexter.")) }
                        return
                    }
                    // A current plan can be used explicitly. A receipt recovered after relaunch only confirms installation.
                    phase = plan != nil && current() ? .ready : .blocked(String(localized: "A instalação foi confirmada. Feche e abra Preparar novamente para escolher usá-la nesta base."))
                } else if [.failed, .cancelled].contains(checked.state) {
                    recovery = .prepareAgain; phase = .blocked(Self.message(checked.error ?? SetupError.cancelled))
                }
                else { phase = .unconfirmed }
            } catch { phase = .unconfirmed }
        }
    }

    private func updateProgress(_ step: RuntimeSetupStep) {
        guard opened, !Task.isCancelled else { return }
        progressStep = step
    }

    /// Only a known terminal failure admits a fresh request. Unknown always keeps the exact original ID/hash.
    public func retry() {
        guard canRetry else { return }
        switch recovery {
        case .none: return
        case .signInAgain:
            guard choiceIsApplied else { return }
            phase = .prepared; signIn()
        case .applyAgain:
            guard receipt?.state == .committed, current() else { return }
            phase = .ready; recovery = .none
        case .sameRequest:
            guard current(), plan != nil else { return }
            phase = .ready; recovery = .none
        case .inspectAgain, .prepareAgain:
            guard current(), receipt == nil || receipt?.state == .failed || receipt?.state == .cancelled else { return }
            capture = SetupCapture(hostID: capture.hostID, bundleID: capture.bundleID,
                selectionGeneration: capture.selectionGeneration, windowID: capture.windowID, requestID: UUID().uuidString)
            plan = nil; receipt = nil; result = nil; applicationWasAttempted = false
            phase = .idle; open()
        }
    }

    public func close() {
        opened = false; operation?.cancel(); operation = nil
        if let signInProcess, signInProcess.isRunning { signInProcess.terminate() }
        if signInProcess?.isRunning != true { signInProcess = nil }
        if phase == .installing || phase == .applying {
            if let plan { receipt = SetupReceipt(requestID: plan.capture.requestID, requestHash: plan.requestHash, state: .unknown) }
            phase = .unconfirmed
            Task { await runtime.cancel(requestID: capture.requestID) }
        } else if phase == .checking { phase = receipt == nil ? .idle : .unconfirmed }
        else if phase == .signingIn { phase = hasOwnedLogin ? .blocked(String(localized: "O login ainda está encerrando. Aguarde antes de iniciar outro.")) : .prepared }
    }

    /// Official interactive login, requested by the owner. No auth file, token, URL, stdout or stderr is retained/read by UI.
    /// The CLI owns browser sign-in and its own account storage. Only this task's process can be cancelled.
    public func signIn() {
        guard [.prepared, .signInFinished].contains(phase), let result,
              signInProcess?.isRunning != true,
              model.isUsingThisMacBase(localAddress: host.launchHostAddress ?? ""), !model.localRuntimeSetupBusy else { return }
        let loginScope = model.filesScope
        phase = .signingIn
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                let url = URL(fileURLWithPath: result.command).resolvingSymlinksInPath()
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard hash == result.sha256, opened, loginScope == model.filesScope,
                      FileManager.default.isExecutableFile(atPath: url.path) else { throw SetupError.artifactChanged }
                let child = Process(); child.executableURL = url
                child.arguments = engine == .claude ? ["auth", "login"] : ["login"]
                let home = FileManager.default.homeDirectoryForCurrentUser.path
                child.environment = ["HOME": home, "USER": NSUserName(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "TMPDIR": NSTemporaryDirectory()]
                child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
                // Discard private login output in the OS; never pipe a URL or account details into app logs.
                child.standardInput = FileHandle.nullDevice; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
                signInProcess = child; try child.run()
                let deadline = ContinuousClock.now.advanced(by: .seconds(300))
                while child.isRunning && ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(200))
                    guard opened, loginScope == model.filesScope, !model.localRuntimeSetupBusy else { throw SetupError.scopeChanged }
                }
                if child.isRunning { child.terminate(); throw SetupError.timedOut }
                signInProcess = nil
                guard !Task.isCancelled, opened else { return }
                recovery = child.terminationStatus == 0 ? .none : .signInAgain
                phase = child.terminationStatus == 0 ? .signInFinished : .blocked(String(localized: "O programa oficial não confirmou o login. Você pode tentar pelo próprio programa e voltar ao Dexter."))
                await model.refreshEngineCatalog()
            } catch {
                if let child = signInProcess, child.isRunning { child.terminate() }
                if signInProcess?.isRunning != true { signInProcess = nil }
                if opened { recovery = choiceIsApplied ? .signInAgain : .none; phase = .blocked(Self.message(error)) }
            }
        }
    }

    static func preference(_ stored: LocalEngineStoredPreference, engine: EngineID, command: String) throws -> LocalEnginePreference {
        guard let kind = LocalEngineKind(rawValue: engine.rawValue), [.claude, .codex].contains(kind) else { throw SetupError.unavailable }
        let candidate = try LocalEngineDiscovery.validateLauncher(command, kind: kind).get()
        switch stored {
        case .unreadable: throw SetupError.storageFailure
        case .missing: return .firstUse(kind: kind, launcher: candidate.launcher)
        case .saved(var preference):
            preference.allowsLocalEngines = true
            if kind == .claude { preference.claudePath = candidate.launcher } else { preference.codexPath = candidate.launcher }
            return preference
        }
    }

    static func verifies(_ result: RuntimeSetupResult, launcher: String) -> Bool {
        guard let kind = LocalEngineKind.allCases.first(where: { $0.launcherNames.contains(URL(fileURLWithPath: launcher).lastPathComponent) }),
              case .success(let candidate) = LocalEngineDiscovery.validateLauncher(launcher, kind: kind),
              candidate.identity.resolvedPath == result.command,
              let bytes = try? Data(contentsOf: URL(fileURLWithPath: candidate.identity.resolvedPath), options: .mappedIfSafe) else { return false }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == result.sha256
    }

    private static func message(_ error: any Error) -> String {
        switch error as? SetupError {
        case .scopeChanged: String(localized: "A base ou a escolha mudou. Nada mais será aplicado; abra Preparar na base desejada.")
        case .cancelled: String(localized: "Preparação cancelada. Uma instalação já concluída pode permanecer neste Mac.")
        case .timedOut: String(localized: "A preparação demorou demais. Confira sua conexão e tente novamente após verificar o resultado.")
        case .checksumMismatch, .signatureRejected, .notarizationRejected, .wrongArchitecture, .unsafeArchive, .unsafeSource, .redirectDenied, .artifactChanged:
            String(localized: "O programa não passou na verificação de origem e integridade. Nenhuma escolha foi aplicada.")
        case .incompatible, .versionMismatch:
            String(localized: "O programa encontrado não oferece a versão ou os recursos necessários. Confira o programa oficial e tente verificar novamente.")
        case .unsafePath:
            String(localized: "O caminho da instalação não é seguro ou não está acessível. Escolha um programa existente em Detalhes técnicos e verifique novamente.")
        case .downloadFailed, .truncated:
            String(localized: "O download oficial não foi concluído. Confira a conexão e tente novamente; nenhum programa será baixado sem sua confirmação.")
        case .storageFailure:
            String(localized: "Não foi possível gravar a preparação na pasta do Dexter. Confira o espaço e as permissões e tente novamente.")
        default: String(localized: "Não foi possível preparar o assistente. Confira a conexão ou escolha uma instalação existente em Detalhes técnicos.")
        }
    }
}
#endif
