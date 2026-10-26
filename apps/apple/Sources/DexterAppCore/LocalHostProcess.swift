#if os(macOS)
import Darwin
import DexterAssistantRuntimeSetup
import DexterHostClient
import Foundation
import Observation

/// Explicit, per-process opt-in for a developer Mac to bring up its own loopback host.
/// Product architecture is unchanged: the user-owned VPS stays the canonical host; this is the
/// optional local development host. Only absolute, caller-supplied paths are accepted.
public enum LocalDeviceCustodyAction: String, Sendable { case create, unlock }

public struct LocalHostLaunchConfiguration: Equatable, Sendable {
    public static let startKey = "DEXTER_LOCAL_HOST_START"
    public static let nodeKey = "DEXTER_LOCAL_HOST_NODE"
    public static let cliKey = "DEXTER_LOCAL_HOST_CLI"
    public static let dataDirKey = "DEXTER_LOCAL_HOST_DATA_DIR"
    public static let portKey = "DEXTER_LOCAL_HOST_PORT"
    public static let enginesKey = "DEXTER_LOCAL_HOST_ENABLE_ENGINES"
    public static let agendaKey = "DEXTER_LOCAL_HOST_ENABLE_AGENDA"
    static let databaseFile = "dexter.sqlite"

    public let node: URL
    public let cli: URL
    public let dataDir: URL
    public let port: UInt16
    /// Real CLI inference costs the user's subscription quota; never on unless explicitly requested.
    public let enableEngines: Bool
    /// Developer launch needs a separate opt-in; packaged engine activation enables its own agenda.
    public let enableAgenda: Bool
    /// Separate consent for the existing Dexter tool gateway; never enables engines or grants tools.
    public let enableMcp: Bool

    public var hostAddress: String { "http://127.0.0.1:\(port)" }

    /// Set only for a packaged bundle: the dedicated parent under Application Support may be created
    /// (never an existing store moved or overwritten) right before the single startup attempt.
    public let createsDataParent: Bool

    /// Controlled PATH for the child, set only when the saved Settings choice enabled local engines on a
    /// packaged bundle (see `LocalEngineActivationPlan`). `nil` keeps the inherited PATH unchanged.
    public let childPath: String?

    /// Exact selected engine executables. nil preserves the legacy developer/metadata launch;
    /// a saved allowing preference supplies only its observed absolute targets.
    public let engineCommands: [LocalEngineKind: String]?
    public let mcpOnePassword: LocalMcpOnePasswordPreference?
    public let localDeviceCustody: LocalDeviceCustodyPreference?
    public let localDeviceCustodyAction: LocalDeviceCustodyAction
    public let appClientChannel: LocalAppClientChannelConfiguration?
    /// Private pipe for this app's owned child; keys are never launch arguments or HTTP bodies.
    public let browserUsePrivateInput: Bool

    public init(node: URL, cli: URL, dataDir: URL, port: UInt16 = 4317, enableEngines: Bool = false, createsDataParent: Bool = false, childPath: String? = nil, engineCommands: [LocalEngineKind: String]? = nil, enableMcp: Bool = false, mcpOnePassword: LocalMcpOnePasswordPreference? = nil, localDeviceCustody: LocalDeviceCustodyPreference? = nil, browserUsePrivateInput: Bool = true, enableAgenda: Bool = false, localDeviceCustodyAction: LocalDeviceCustodyAction = .unlock, appClientChannel: LocalAppClientChannelConfiguration? = nil) {
        self.node = node; self.cli = cli; self.dataDir = dataDir; self.port = port; self.enableEngines = enableEngines
        self.createsDataParent = createsDataParent; self.childPath = childPath; self.engineCommands = engineCommands
        self.enableMcp = enableEngines && enableMcp
        self.mcpOnePassword = mcpOnePassword
        self.localDeviceCustody = localDeviceCustody
        self.localDeviceCustodyAction = localDeviceCustodyAction
        self.appClientChannel = appClientChannel
        self.browserUsePrivateInput = browserUsePrivateInput
        self.enableAgenda = enableAgenda
    }

    func requiringCustodyAction(_ action: LocalDeviceCustodyAction) -> Self {
        var custody = localDeviceCustody; custody?.autostartPreparedAgent = false
        return Self(node: node, cli: cli, dataDir: dataDir, port: port, enableEngines: enableEngines,
            createsDataParent: createsDataParent, childPath: childPath, engineCommands: engineCommands,
            enableMcp: enableMcp, mcpOnePassword: mcpOnePassword, localDeviceCustody: custody,
            browserUsePrivateInput: browserUsePrivateInput, enableAgenda: enableAgenda, localDeviceCustodyAction: action,
            appClientChannel: action == .unlock ? appClientChannel?.unlocking() : appClientChannel)
    }

    func withAppClientChannel(_ channel: LocalAppClientChannelConfiguration?) -> Self {
        Self(node: node, cli: cli, dataDir: dataDir, port: port, enableEngines: enableEngines,
             createsDataParent: createsDataParent, childPath: childPath, engineCommands: engineCommands,
             enableMcp: enableMcp, mcpOnePassword: mcpOnePassword, localDeviceCustody: localDeviceCustody,
             browserUsePrivateInput: browserUsePrivateInput, enableAgenda: enableAgenda,
             localDeviceCustodyAction: localDeviceCustodyAction, appClientChannel: channel)
    }

    /// Applies the explicit Settings choice to a packaged configuration only (never to the developer
    /// environment override). Missing: the packaged metadata flag stands. Unreadable or not allowed:
    /// engines off. Allowed: engines on with a validated controlled PATH, or a sanitized failure.
    func applyingLocalEnginePreference(_ stored: LocalEngineStoredPreference, includeDeviceChannel: Bool = false, custodyAction: LocalDeviceCustodyAction = .unlock) -> Result<LocalHostLaunchConfiguration, LocalHostFailure> {
        func with(_ engines: Bool, _ path: String?, commands: [LocalEngineKind: String]? = nil, tools: Bool = false, onePassword: LocalMcpOnePasswordPreference? = nil, deviceCustody: LocalDeviceCustodyPreference? = nil) -> LocalHostLaunchConfiguration {
            LocalHostLaunchConfiguration(node: node, cli: cli, dataDir: dataDir, port: port, enableEngines: engines,
                                         createsDataParent: createsDataParent, childPath: path, engineCommands: commands, enableMcp: tools, mcpOnePassword: onePassword, localDeviceCustody: deviceCustody, browserUsePrivateInput: browserUsePrivateInput, enableAgenda: enableAgenda || createsDataParent, localDeviceCustodyAction: custodyAction, appClientChannel: appClientChannel)
        }
        switch stored {
        case .missing: return .success(self)
        case .unreadable: return .success(with(false, nil))
        case .saved(let preference) where !preference.allowsLocalEngines: return .success(with(false, nil))
        case .saved(let preference):
            switch localEngineActivation(preference) {
            case .success(let plan): return .success(with(true, plan.path, commands: plan.commands, tools: preference.allowsDexterTools,
                                                        onePassword: preference.allowsDexterTools ? preference.mcpOnePassword : nil,
                                                        deviceCustody: includeDeviceChannel && preference.allowsDexterTools ? preference.localDeviceCustody : nil))
            case .failure: return .failure(.invalidConfiguration(LocalHostFailure.localEnginesNotApplied))
            }
        }
    }

    /// Plan against this bundle's own Helpers folder and bundled Node.
    func localEngineActivation(_ preference: LocalEnginePreference) -> Result<LocalEngineActivationPlan, LocalEngineActivationIssue> {
        if let onePassword = preference.mcpOnePassword, onePassword.validatedCommand == nil {
            return .failure(.invalidMcpOnePassword)
        }
        return LocalEngineActivationPlan.makeBound(preference, helpersDirectory: node.deletingLastPathComponent().path,
            bundledNode: node.path, bindingsRoot: dataDir.deletingLastPathComponent().resolvingSymlinksInPath()
                .appendingPathComponent(dataDir.lastPathComponent + ".engine-launchers", isDirectory: true))
    }

    func prepareSelectedEngineBindings() -> LocalHostFailure? {
        guard let engineCommands, !engineCommands.isEmpty, let childPath,
              let first = childPath.split(separator: ":").first else { return nil }
        let directory = URL(fileURLWithPath: String(first), isDirectory: true)
        var chosen: [LocalEngineKind: LocalEngineCandidate] = [:]
        for (kind, command) in engineCommands {
            guard let identity = LocalEngineDiscovery.fileIdentity(command) else { return .invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
            chosen[kind] = LocalEngineCandidate(kind: kind, launcher: command, identity: identity)
        }
        guard let binding = try? LocalEngineLaunchBindings(root: directory.deletingLastPathComponent(), chosen: chosen),
              binding.directory == directory else { return .invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
        do { try binding.prepare(); return nil } catch { return .invalidConfiguration(LocalHostFailure.localEnginesNotApplied) }
    }

    /// `nil` when the opt-in flag is absent; otherwise a validated configuration or a sanitized failure.
    public static func fromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> Result<LocalHostLaunchConfiguration, LocalHostFailure>? {
        guard env[startKey] == "1" else { return nil }
        guard let node = absolutePath(env[nodeKey]), let cli = absolutePath(env[cliKey]), let data = absolutePath(env[dataDirKey]) else {
            return .failure(.invalidConfiguration(String(localized: "Node, CLI and data directory must be absolute paths.")))
        }
        var port: UInt16 = 4317
        if let raw = env[portKey] {
            guard let parsed = UInt16(raw), parsed >= 1024 else { return .failure(.invalidConfiguration(String(localized: "Port must be 1024–65535."))) }
            port = parsed
        }
        let engines = env[enginesKey]
        guard engines == nil || engines == "0" || engines == "1" else { return .failure(.invalidConfiguration(String(localized: "Engine opt-in must be 0 or 1."))) }
        let agenda = env[agendaKey]
        guard agenda == nil || agenda == "0" || agenda == "1", agenda != "1" || engines == "1" else { return .failure(.invalidConfiguration(String(localized: "Agenda opt-in requires enabled engines."))) }
        let config = LocalHostLaunchConfiguration(node: node, cli: cli, dataDir: data, port: port, enableEngines: engines == "1", enableAgenda: agenda == "1")
        if let failure = config.validate() { return .failure(failure) }
        return .success(config)
    }

    /// Written by scripts/package-local-desktop.mjs, relative to `Contents/`. Present only in a bundle
    /// explicitly packaged for optional local development; absent means disarmed (normal refresh).
    static let packagedMetadataPath = "Resources/DexterLocalHost/launch.json"
    static let packagedSchema = "dexter.local-host-launch/1"
    /// Separate from client state (`Application Support/Dexter`); no store is migrated into it.
    static let packagedStoreRoot = "Dexter Local Host"

    private struct PackagedMetadata: Decodable {
        let schema: String, mode: String, node: String, cli: String, port: Int, enableEngines: Bool, storeName: String
    }

    /// `nil` without packaged metadata; otherwise a configuration whose paths resolve inside this
    /// bundle (so the .app can be moved), or a sanitized failure. Filesystem checks run in `start()`.
    public static func fromBundle(_ bundle: Bundle = .main, fileManager: FileManager = .default) -> Result<LocalHostLaunchConfiguration, LocalHostFailure>? {
        let contents = bundle.bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let metadataURL = contents.appendingPathComponent(packagedMetadataPath)
        guard fileManager.fileExists(atPath: metadataURL.path) else { return nil }
        let invalid = Result<LocalHostLaunchConfiguration, LocalHostFailure>.failure(
            .invalidConfiguration(String(localized: "The packaged local host configuration is invalid; repackage the app.")))
        guard let data = try? Data(contentsOf: metadataURL), data.count <= 16_384,
              let keys = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]).map({ Set($0.keys) }),
              keys == ["schema", "mode", "node", "cli", "port", "enableEngines", "storeName"],
              let metadata = try? JSONDecoder().decode(PackagedMetadata.self, from: data),
              metadata.schema == packagedSchema, metadata.mode == "local-development",
              (1024...65535).contains(metadata.port), isStoreName(metadata.storeName),
              let node = contained(metadata.node, in: contents), let cli = contained(metadata.cli, in: contents),
              let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return invalid }
        let dataDir = support.appendingPathComponent(packagedStoreRoot, isDirectory: true)
            .appendingPathComponent(metadata.storeName, isDirectory: true).standardizedFileURL
        return .success(LocalHostLaunchConfiguration(node: node, cli: cli, dataDir: dataDir, port: UInt16(metadata.port),
                                                     enableEngines: metadata.enableEngines, createsDataParent: true, enableAgenda: true))
    }

    /// Relative path without empty, `.` or `..` segments whose resolved target stays inside `Contents/`.
    private static func contained(_ relative: String, in contents: URL) -> URL? {
        guard !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains("\0"), relative.utf8.count <= 512,
              relative.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
        else { return nil }
        let root = contents.resolvingSymlinksInPath().standardizedFileURL
        let url = root.appendingPathComponent(relative, isDirectory: false).resolvingSymlinksInPath().standardizedFileURL
        return url.path.hasPrefix(root.path + "/") ? url : nil
    }

    private static func isStoreName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, name.unicodeScalars.count <= 64,
              CharacterSet.alphanumerics.contains(first), first.isASCII else { return false }
        return name.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "._-".unicodeScalars.contains($0)) }
    }

    /// Creates only the dedicated parent directory (owner-only) when packaged; the store directory
    /// itself is left to the host and the existing preflight. The parent must end up a plain
    /// directory (not a symlink), so the store cannot be redirected outside the dedicated location.
    func prepareDataParent(fileManager: FileManager = .default) -> LocalHostFailure? {
        guard createsDataParent else { return nil }
        let parent = dataDir.deletingLastPathComponent().path
        let failure = LocalHostFailure.invalidConfiguration(String(localized: "The local host data folder could not be prepared as a plain directory; nothing was started."))
        if (try? fileManager.attributesOfItem(atPath: parent)) == nil {
            do { try fileManager.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
            catch { return failure }
        }
        // attributesOfItem does not follow a final symlink: an alias reports .typeSymbolicLink.
        guard (try? fileManager.attributesOfItem(atPath: parent)[.type] as? FileAttributeType) == .typeDirectory else { return failure }
        return nil
    }

    /// Called only for explicit Apply. Creates the dedicated private leaf directory, never repairs it.
    func prepareDeviceCustodyParent() -> LocalHostFailure? {
        guard let custody = localDeviceCustody else { return nil }
        let hostRoot = dataDir.standardizedFileURL.path
        guard custody.isWellFormed, enableMcp,
              custody.filePath != hostRoot, !custody.filePath.hasPrefix(hostRoot + "/") else { return .deviceCustodyUnavailable }
        let parent = (custody.filePath as NSString).deletingLastPathComponent
        var info = stat()
        if lstat(parent, &info) != 0 {
            guard errno == ENOENT, Self.hasPlainAncestors((parent as NSString).deletingLastPathComponent) else { return .deviceCustodyUnavailable }
            do { try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
            catch { return .deviceCustodyUnavailable }
        }
        return deviceCustodyFailure()
    }

    private static func hasPlainAncestors(_ path: String) -> Bool {
        var current = ""
        for part in path.split(separator: "/") {
            current += "/" + part
            var info = stat()
            guard lstat(current, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { return false }
        }
        return true
    }

    private func deviceCustodyFailure() -> LocalHostFailure? {
        guard let custody = localDeviceCustody else { return nil }
        let hostRoot = dataDir.standardizedFileURL.path
        guard custody.isWellFormed, enableMcp,
              custody.filePath != hostRoot, !custody.filePath.hasPrefix(hostRoot + "/") else { return .deviceCustodyUnavailable }
        let parent = (custody.filePath as NSString).deletingLastPathComponent
        guard Self.hasPlainAncestors(parent) else { return .deviceCustodyUnavailable }
        var parentInfo = stat()
        guard lstat(parent, &parentInfo) == 0, parentInfo.st_uid == getuid(), parentInfo.st_mode & 0o777 == 0o700 else { return .deviceCustodyUnavailable }
        var fileInfo = stat()
        if lstat(custody.filePath, &fileInfo) != 0 { return errno == ENOENT && localDeviceCustodyAction == .create ? nil : .deviceCustodyUnavailable }
        guard localDeviceCustodyAction == .unlock, fileInfo.st_mode & S_IFMT == S_IFREG, fileInfo.st_uid == getuid(),
              fileInfo.st_nlink == 1, fileInfo.st_mode & 0o777 == 0o600, fileInfo.st_size > 0,
              fileInfo.st_size <= 8 * 1024 * 1024 else { return .deviceCustodyUnavailable }
        return nil
    }

    private static func absolutePath(_ raw: String?) -> URL? {
        guard let raw, raw.hasPrefix("/"), !raw.contains("\0"),
              !raw.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        return URL(fileURLWithPath: raw, isDirectory: false).standardizedFileURL
    }

    /// Filesystem preflight. Refuses an arbitrary non-empty directory that is not already a Dexter store.
    public func validate(fileManager: FileManager = .default) -> LocalHostFailure? {
        if let failure = deviceCustodyFailure() { return failure }
        if let onePassword = mcpOnePassword,
           !enableMcp || onePassword.validatedCommand == nil {
            return .invalidConfiguration(String(localized: "The MCP 1Password configuration is incomplete or unavailable. Review it in Settings; nothing was started."))
        }
        guard fileManager.isExecutableFile(atPath: node.path), isRegularFile(node.path, fileManager) else {
            return .missingPrerequisite(String(localized: "Node executable not found at the configured path."))
        }
        guard cli.pathExtension == "js", isRegularFile(cli.path, fileManager) else {
            return .missingPrerequisite(String(localized: "Host CLI entry not found at the configured path. Build packages/cli first."))
        }
        var isDir: ObjCBool = false
        if fileManager.fileExists(atPath: dataDir.path, isDirectory: &isDir) {
            guard isDir.boolValue, !isSymlink(dataDir.path, fileManager) else {
                return .invalidConfiguration(String(localized: "The data directory path is not a plain directory."))
            }
            guard let entries = try? fileManager.contentsOfDirectory(atPath: dataDir.path) else {
                return .invalidConfiguration(String(localized: "The data directory could not be read."))
            }
            let isStore = isRegularFile(dataDir.appendingPathComponent(Self.databaseFile).path, fileManager)
            guard isStore || entries.isEmpty else {
                return .invalidConfiguration(String(localized: "The data directory is not empty and is not a Dexter store; choose a dedicated directory."))
            }
        } else {
            var parentIsDir: ObjCBool = false
            guard fileManager.fileExists(atPath: dataDir.deletingLastPathComponent().path, isDirectory: &parentIsDir), parentIsDir.boolValue else {
                return .invalidConfiguration(String(localized: "The data directory's parent does not exist."))
            }
        }
        return nil
    }

    private func isRegularFile(_ path: String, _ fm: FileManager) -> Bool {
        (try? fm.attributesOfItem(atPath: path)[.type] as? FileAttributeType) == .typeRegular
            || (try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
    }

    private func isSymlink(_ path: String, _ fm: FileManager) -> Bool {
        (try? fm.attributesOfItem(atPath: path)[.type] as? FileAttributeType) == .typeSymbolicLink
    }

    /// Argument vector only; `Process` never goes through a shell.
    var arguments: [String] {
        var values = [cli.path, "serve", "--data-dir", dataDir.path, "--port", String(port)]
        if browserUsePrivateInput { values.append("--browser-use-private-input") }
        if let channel = appClientChannel {
            values += ["--app-client-custody-file", channel.custodyFile, "--app-client-custody-action", channel.action.rawValue,
                       "--app-client-listen", channel.address, "--app-client-port", String(LocalAppClientChannelConfiguration.port),
                       "--app-client-expected-host", channel.installationID, "--app-client-expected-owner", channel.ownerID]
        }
        guard enableEngines else { return values }
        values.append("--enable-engines")
        if enableAgenda { values.append("--enable-agenda") }
        for kind in LocalEngineKind.allCases {
            if let command = engineCommands?[kind] { values += ["--\(kind.rawValue)-command", command] }
        }
        if enableMcp {
            values.append("--enable-mcp")
            values.append("--enable-bot-delegation")
            if let onePassword = mcpOnePassword {
                values += ["--mcp-op-command", onePassword.command, "--mcp-vault", onePassword.vault]
                if let account = onePassword.account { values += ["--mcp-op-account", account] }
            }
            if let custody = localDeviceCustody {
                let action = localDeviceCustodyAction.rawValue
                values += ["--local-device-custody-file", custody.filePath, "--local-device-custody-action", action,
                           "--local-device-password-fd", "0", "--device-port", "0"]
                if custody.allowsDeviceTools { values.append("--enable-device-tools") }
            }
        }
        return values
    }
}

/// User-facing failures. Messages are fixed strings: raw child stderr/stdout is never surfaced.
public enum LocalHostFailure: Error, Equatable, Sendable {
    case deviceUnlockRequired
    case deviceCustodyUnavailable
    case invalidConfiguration(String)
    case missingPrerequisite(String)
    case portInUse(UInt16)
    case launchFailed
    case startupTimedOut
    case exitedBeforeReady(code: Int32, hint: String?)
    case exitedAfterReady(code: Int32)
    /// The ready object did not match the exact expected URL, mode, engine and tool-gateway state.
    case readyContractMismatch
    case connectionNotLocal

    static let localEnginesNotApplied = String(localized: "Local engine settings could not be applied; nothing was started. Review them in Settings, then reopen Dexter.")

    public var message: String {
        switch self {
        case .deviceUnlockRequired: return String(localized: "Enter a passphrase of 16–1024 UTF-8 bytes in Settings to unlock this Mac's encrypted channel.")
        case .deviceCustodyUnavailable: return String(localized: "The encrypted channel file or its private folder is unavailable. Nothing was replaced; review the saved path in Settings.")
        case .invalidConfiguration(let text), .missingPrerequisite(let text): return text
        case .portInUse(let port): return String(localized: "Port \(port) is already in use by a process Dexter did not start. It was not stopped or reused.")
        case .launchFailed: return String(localized: "The local host process could not be launched.")
        case .startupTimedOut: return String(localized: "The local host did not become ready in time; a graceful stop was requested.")
        case .exitedBeforeReady(let code, let hint): return String(localized: "The local host exited during startup (code \(code)).") + (hint.map { " " + $0 } ?? "")
        case .exitedAfterReady(let code): return String(localized: "The local host stopped unexpectedly (code \(code)).")
        case .readyContractMismatch: return String(localized: "The local host reported an unexpected startup state (address, mode, engine or tools setting); a graceful stop was requested.")
        case .connectionNotLocal: return String(localized: "The app is not set to this local loopback host; local startup was skipped.")
        }
    }
}

public enum LocalHostState: Equatable, Sendable {
    case idle
    case starting
    case running(address: String)
    case failed(LocalHostFailure)
    case stopping
    case stopped
    /// The child did not exit within the grace period. It was not force-killed: the host keeps its
    /// writer lease and store until its own shutdown completes.
    case stopUncertain
}

/// Minimal seam over `Foundation.Process` so lifecycle can be exercised with fakes.
@MainActor
public protocol LocalHostChild: AnyObject {
    var isRunning: Bool { get }
    var terminationStatus: Int32 { get }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws
    /// Graceful request only (SIGTERM → host `stop()` → runtime shutdown).
    func requestGracefulStop()
    func providePrivateInput(_ bytes: Data) throws
    func provideBrowserUseKeyFrame(_ frame: Data) throws
    func provideMemoryBackendKeyFrame(_ frame: Data) throws
    /// UX-P1-10: one private OAuth custody frame to the owned child (the open after ready, or a result to its own request).
    func provideMcpOAuthCustodyFrame(_ frame: Data) throws
    /// One private connections-service capability frame (set/lock) to the owned child.
    func provideConnectionsCapabilityFrame(_ frame: Data) throws
}

public extension LocalHostChild {
    func providePrivateInput(_ bytes: Data) throws { throw LocalHostFailure.launchFailed }
    func provideBrowserUseKeyFrame(_ frame: Data) throws { throw BrowserUseKeyFailure.bridgeUnavailable }
    func provideMemoryBackendKeyFrame(_ frame: Data) throws { throw MemoryBackendPrivateFailure.bridgeUnavailable }
    func provideMcpOAuthCustodyFrame(_ frame: Data) throws { throw McpOAuthCustodyFailure.unavailable }
    func provideConnectionsCapabilityFrame(_ frame: Data) throws { throw ConnectionsPrivateFailure.bridgeUnavailable }
}

/// An owned, one-shot memory buffer. Never Codable, argv, environment or launch configuration.
@MainActor public final class LocalHostUnlockPassword {
    private var bytes: Data
    public init?(_ text: String) {
        let data = Data(text.utf8)
        guard (16...1_024).contains(data.count) else { return nil }
        bytes = data
    }
    public init(ownedBytes: OwnedLocalHostUnlockBytes) throws {
        bytes = try ownedBytes.consume { Data($0) }
    }
    public func clear() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll(keepingCapacity: false) }
    func handoff(to child: any LocalHostChild) throws {
        defer { clear() }
        guard (16...1_024).contains(bytes.count) else { throw LocalHostFailure.deviceUnlockRequired }
        try child.providePrivateInput(bytes)
    }
    deinit { bytes.resetBytes(in: 0..<bytes.count) }
}

@MainActor
public final class FoundationLocalHostChild: LocalHostChild {
    private let process = Process()
    private let stdout = Pipe()
    private let stderr = Pipe()
    private let privateInput: Pipe?
    private let usesFramedPrivateInput: Bool

    public init(configuration: LocalHostLaunchConfiguration, environment: [String: String]) {
        usesFramedPrivateInput = configuration.browserUsePrivateInput
        privateInput = configuration.browserUsePrivateInput || configuration.localDeviceCustody != nil ? Pipe() : nil
        process.executableURL = configuration.node
        process.arguments = configuration.arguments
        process.currentDirectoryURL = configuration.cli.deletingLastPathComponent()
        process.environment = environment
        if let privateInput { process.standardInput = privateInput } else { process.standardInput = FileHandle.nullDevice }
        process.standardOutput = stdout
        process.standardError = stderr
    }

    public var isRunning: Bool { process.isRunning }
    public var terminationStatus: Int32 { process.isRunning ? 0 : process.terminationStatus }

    public func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws {
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { onStdout(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { onStderr(data) }
        }
        process.terminationHandler = { _ in onExit() }
        try process.run()
    }

    public func requestGracefulStop() { if process.isRunning { process.terminate() } }

    public func providePrivateInput(_ bytes: Data) throws {
        guard let privateInput else { throw LocalHostFailure.launchFailed }
        guard (16...1_024).contains(bytes.count) else { throw LocalHostFailure.deviceUnlockRequired }
        if usesFramedPrivateInput {
            var frame = try JSONSerialization.data(withJSONObject: ["schema": "dexter.private-input/1", "kind": "unlock", "passwordBase64": bytes.base64EncodedString()])
            defer { frame.resetBytes(in: 0..<frame.count) }
            frame.append(0x0a)
            try privateInput.fileHandleForWriting.write(contentsOf: frame)
        } else {
            defer { try? privateInput.fileHandleForWriting.close() }
            try privateInput.fileHandleForWriting.write(contentsOf: bytes)
        }
    }

    public func provideMemoryBackendKeyFrame(_ frame: Data) throws {
        guard usesFramedPrivateInput, let privateInput, process.isRunning,
              !frame.isEmpty, frame.count <= 16_384, frame.last == 0x0a else { throw MemoryBackendPrivateFailure.bridgeUnavailable }
        try privateInput.fileHandleForWriting.write(contentsOf: frame)
    }
    public func provideBrowserUseKeyFrame(_ frame: Data) throws {
        guard usesFramedPrivateInput, let privateInput, process.isRunning,
              !frame.isEmpty, frame.count <= 16_384, frame.last == 0x0a else { throw BrowserUseKeyFailure.bridgeUnavailable }
        try privateInput.fileHandleForWriting.write(contentsOf: frame)
    }
    public func provideMcpOAuthCustodyFrame(_ frame: Data) throws {
        guard usesFramedPrivateInput, let privateInput, process.isRunning,
              !frame.isEmpty, frame.count <= 16_384, frame.last == 0x0a else { throw McpOAuthCustodyFailure.unavailable }
        try privateInput.fileHandleForWriting.write(contentsOf: frame)
    }
    public func provideConnectionsCapabilityFrame(_ frame: Data) throws {
        guard usesFramedPrivateInput, let privateInput, process.isRunning,
              !frame.isEmpty, frame.count <= 16_384, frame.last == 0x0a else { throw ConnectionsPrivateFailure.bridgeUnavailable }
        try privateInput.fileHandleForWriting.write(contentsOf: frame)
    }
}

/// Supervises exactly one host child that this app launched. Never signals, adopts or reuses
/// any other process, including an unknown listener on the configured port.
@Observable @MainActor
public final class LocalHostSupervisor {
    public private(set) var state: LocalHostState = .idle
    public let configuration: LocalHostLaunchConfiguration
    public private(set) var memoryBackendLifetime = UUID()

    @ObservationIgnored private var child: (any LocalHostChild)?
    @ObservationIgnored private var stdoutBuffer = Data()
    @ObservationIgnored private var stderrTail = Data()
    @ObservationIgnored private var readyWaiter: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var exitWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var exited = false
    @ObservationIgnored private var rejection: LocalHostFailure?
    @ObservationIgnored private var stopTask: Task<LocalHostState, Never>?
    @ObservationIgnored private var browserUseAckBuffer = Data()
    @ObservationIgnored private var browserUseReadyHostID: String?
    @ObservationIgnored private var browserUseAck: (id: String, hostID: String, operation: String, waiter: CheckedContinuation<Void, Error>)?
    @ObservationIgnored private var memoryBackendAck: (intent: MemoryBackendPrivateIntent, waiter: CheckedContinuation<Void,Error>)?
    public private(set) var unconfirmedMemoryBackendIntent: MemoryBackendPrivateIntent?
    @ObservationIgnored private var connectionsAck: (intent: ConnectionsPrivateIntent, waiter: CheckedContinuation<Void,Error>)?
    public private(set) var unconfirmedConnectionsIntent: ConnectionsPrivateIntent?
    /// Called when the owned child exits after it was ready, so the app can explain the loss.
    public private(set) var localDeviceChannelAddress: String?
    public private(set) var confirmedOwnerID: String?
    public var confirmedHostID: String? { isRunning && child?.isRunning == true ? browserUseReadyHostID : nil }
    @ObservationIgnored public var onUnexpectedExit: (@MainActor (LocalHostFailure) -> Void)?
    @ObservationIgnored private let makeChild: @MainActor (LocalHostLaunchConfiguration, [String: String]) -> any LocalHostChild
    @ObservationIgnored private let portIsFree: @Sendable (UInt16) -> Bool
    /// UX-P1-10 custodian of native MCP OAuth tokens for this owned child only (nil without MCP or the private pipe).
    @ObservationIgnored private let mcpOAuthCustody: McpOAuthCustodyResponder?
    private static let bufferCap = 64 * 1024

    public init(
        configuration: LocalHostLaunchConfiguration,
        makeChild: @escaping @MainActor (LocalHostLaunchConfiguration, [String: String]) -> any LocalHostChild = { FoundationLocalHostChild(configuration: $0, environment: $1) },
        portIsFree: @escaping @Sendable (UInt16) -> Bool = LocalHostSupervisor.loopbackPortIsFree,
        mcpOAuthCustodyStore: (any McpOAuthCustodyStore)? = nil
    ) {
        self.configuration = configuration
        self.makeChild = makeChild
        self.portIsFree = portIsFree
        let store = mcpOAuthCustodyStore ?? (configuration.enableMcp && configuration.browserUsePrivateInput ? NativeMcpOAuthKeychain() : nil)
        self.mcpOAuthCustody = configuration.browserUsePrivateInput ? store.map(McpOAuthCustodyResponder.init(store:)) : nil
    }

    public var isRunning: Bool { if case .running = state { return true }; return false }
    /// True while a child this supervisor launched has not been observed to exit, in any state.
    public var ownsLiveChild: Bool { child != nil && !exited }
    var hasConfirmedChildExit: Bool { exited && child == nil }

    /// Identity comes from the owned child's ready frame, never an arbitrary loopback listener.
    public func canManageBrowserUseKey(hostID: String) -> Bool {
        configuration.browserUsePrivateInput && ownsLiveChild && isRunning && child?.isRunning == true && browserUseReadyHostID == hostID
    }

    /// Explicit human action only. A bounded private write is acknowledged by the exact owned child.
    public func setBrowserUseKey(_ key: String?, hostID: String, timeout: Duration = .seconds(15)) async throws {
        guard !Task.isCancelled, canManageBrowserUseKey(hostID: hostID), browserUseAck == nil, let child else { throw BrowserUseKeyFailure.bridgeUnavailable }
        let operation = key == nil ? "lock" : "set"
        let id = UUID().uuidString.lowercased()
        var object = ["schema": "dexter.browser-use-key/1", "requestId": id, "hostID": hostID, "operation": operation]
        if let key {
            guard BrowserUseKeyValidation.isValid(key) else { throw BrowserUseKeyFailure.invalidConfiguration }
            object["key"] = key
        }
        var frame = try JSONSerialization.data(withJSONObject: object)
        frame.append(0x0a)
        defer { frame.resetBytes(in: 0..<frame.count) }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void, Error>) in
                guard !Task.isCancelled else { waiter.resume(throwing: BrowserUseKeyFailure.bridgeUnconfirmed); return }
                browserUseAck = (id, hostID, operation, waiter)
                do { try child.provideBrowserUseKeyFrame(frame) }
                catch { finishBrowserUseAck(id: id, result: .failure(BrowserUseKeyFailure.bridgeUnconfirmed)) }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: timeout)
                    self?.finishBrowserUseAck(id: id, result: .failure(BrowserUseKeyFailure.bridgeUnconfirmed))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finishBrowserUseAck(id: id, result: .failure(BrowserUseKeyFailure.bridgeUnconfirmed)) }
        }
    }

    public func canManageMemoryBackend(hostID: String) -> Bool { canManageBrowserUseKey(hostID: hostID) }
    /// Only the own inherited parent Pipe. A missing ACK is unknown and never retries private create/unlock.
    public func sendMemoryBackendFrame(_ frame: MemoryBackendPrivateFrame, timeout: Duration = .seconds(15)) async throws {
        defer { frame.clear() }
        let intent = frame.intent
        guard !Task.isCancelled, canManageMemoryBackend(hostID: intent.scope.hostID), memoryBackendAck == nil,
              (unconfirmedMemoryBackendIntent == nil || intent.operation == .lock), let child else { throw MemoryBackendPrivateFailure.bridgeUnavailable }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void,Error>) in
                guard !Task.isCancelled else { waiter.resume(throwing: MemoryBackendPrivateFailure.bridgeUnavailable); return }
                memoryBackendAck = (intent,waiter)
                do { try frame.handoff(to: child) }
                catch { finishMemoryBackendAck(intent.requestID, result: .failure(MemoryBackendPrivateFailure.outcomeUnknown)) }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: timeout)
                    self?.finishMemoryBackendAck(intent.requestID, result: .failure(MemoryBackendPrivateFailure.outcomeUnknown))
                }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.finishMemoryBackendAck(intent.requestID, result: .failure(MemoryBackendPrivateFailure.outcomeUnknown)) } }
    }
    /// GET status alone resolves only this exact original request, never a revision/state coincidence.
    @discardableResult public func reconcileMemoryBackend(_ intent: MemoryBackendPrivateIntent, status: MemoryBackendStatus) -> Bool {
        guard canManageMemoryBackend(hostID: intent.scope.hostID), unconfirmedMemoryBackendIntent == intent,
              status.isValid, let request = status.privateRequest, request.requestId == intent.requestID,
              request.operation == intent.operation, request.revision == intent.expectedRevision,
              status.settings.origin == intent.scope.origin, status.settings.revision == intent.expectedRevision,
              request.state == "refused" || request.state == (intent.operation == .lock ? "locked" : "ready") else { return false }
        unconfirmedMemoryBackendIntent = nil; return true
    }
    public func canManageConnectionsPlatform(hostID: String) -> Bool { canManageBrowserUseKey(hostID: hostID) }
    /// Only the own inherited parent Pipe. A missing ACK is unknown: the exact request id is settled by GET, never resent.
    public func sendConnectionsCapabilityFrame(_ frame: ConnectionsPrivateFrame, timeout: Duration = .seconds(15)) async throws {
        defer { frame.clear() }
        let intent = frame.intent
        guard !Task.isCancelled, canManageConnectionsPlatform(hostID: intent.scope.hostID), connectionsAck == nil,
              (unconfirmedConnectionsIntent == nil || intent.operation == .lock), let child else { throw ConnectionsPrivateFailure.bridgeUnavailable }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Void,Error>) in
                guard !Task.isCancelled else { waiter.resume(throwing: ConnectionsPrivateFailure.bridgeUnavailable); return }
                connectionsAck = (intent, waiter)
                do { try frame.handoff(to: child) }
                catch { finishConnectionsAck(intent.requestID, result: .failure(ConnectionsPrivateFailure.outcomeUnknown)) }
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: timeout)
                    self?.finishConnectionsAck(intent.requestID, result: .failure(ConnectionsPrivateFailure.outcomeUnknown))
                }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.finishConnectionsAck(intent.requestID, result: .failure(ConnectionsPrivateFailure.outcomeUnknown)) } }
    }
    /// GET status alone resolves only this exact original request (id, operation, generation, owner), never a coincidence.
    @discardableResult public func reconcileConnectionsCapability(_ intent: ConnectionsPrivateIntent, status: ConnectionsConfigurationStatus) -> Bool {
        guard canManageConnectionsPlatform(hostID: intent.scope.hostID), unconfirmedConnectionsIntent == intent, status.isValid,
              status.hostId == intent.scope.hostID, status.ownerId == intent.scope.ownerID, let request = status.privateRequest,
              request.requestId == intent.requestID, request.operation == intent.operation, request.generation == intent.scope.generation,
              request.state == .refused || request.state == (intent.operation == .lock ? .locked : .ready) else { return false }
        unconfirmedConnectionsIntent = nil; return true
    }
    private func finishConnectionsAck(_ id: String, result: Result<Void,Error>) {
        guard let pending = connectionsAck, pending.intent.requestID == id else { return }
        connectionsAck = nil
        if case .failure(let error) = result, error as? ConnectionsPrivateFailure == .outcomeUnknown { unconfirmedConnectionsIntent = pending.intent }
        if case .success = result, pending.intent.operation == .lock { unconfirmedConnectionsIntent = nil }
        pending.waiter.resume(with: result)
    }
    private func receiveConnectionsAck(_ object: [String:Any]) {
        guard let pending = connectionsAck,
              object["requestId"] as? String == pending.intent.requestID, object["hostID"] as? String == pending.intent.scope.hostID,
              browserUseReadyHostID == pending.intent.scope.hostID, let status = object["status"] as? String, ["ready","locked","refused"].contains(status),
              Set(object.keys) == ["schema","requestId","hostID","status"] || Set(object.keys) == ["schema","requestId","hostID","status","code"] else { return }
        if status == "refused" {
            guard object["code"] as? String == "private_input_refused" else { return }
            finishConnectionsAck(pending.intent.requestID, result: .failure(ConnectionsPrivateFailure.refused)); return
        }
        guard object["code"] == nil else { return }
        let expected = pending.intent.operation == .lock ? "locked" : "ready"
        finishConnectionsAck(pending.intent.requestID, result: status == expected ? .success(()) : .failure(ConnectionsPrivateFailure.outcomeUnknown))
    }
    private func finishMemoryBackendAck(_ id: String, result: Result<Void,Error>) {
        guard let pending = memoryBackendAck, pending.intent.requestID == id else { return }
        memoryBackendAck = nil
        if case .failure(let error) = result, error as? MemoryBackendPrivateFailure == .outcomeUnknown { unconfirmedMemoryBackendIntent = pending.intent }
        if case .success = result, pending.intent.operation == .lock { unconfirmedMemoryBackendIntent = nil }
        pending.waiter.resume(with: result)
    }
    private func receiveMemoryBackendAck(_ object: [String:Any]) {
        guard let pending = memoryBackendAck,
              object["requestId"] as? String == pending.intent.requestID, object["hostID"] as? String == pending.intent.scope.hostID,
              browserUseReadyHostID == pending.intent.scope.hostID, let status = object["status"] as? String,
              ["ready","locked","refused"].contains(status),
              Set(object.keys) == ["schema","requestId","hostID","status"] || Set(object.keys) == ["schema","requestId","hostID","status","code"] else { return }
        if status == "refused" {
            guard object["code"] as? String == "private_input_refused" else { return }
            finishMemoryBackendAck(pending.intent.requestID, result: .failure(MemoryBackendPrivateFailure.refused)); return
        }
        guard object["code"] == nil else { return }
        let expected = pending.intent.operation == .lock ? "locked" : "ready"
        finishMemoryBackendAck(pending.intent.requestID, result: status == expected ? .success(()) : .failure(MemoryBackendPrivateFailure.outcomeUnknown))
    }
    private func finishBrowserUseAck(id: String, result: Result<Void, Error>) {
        guard let pending = browserUseAck, pending.id == id else { return }
        browserUseAck = nil; pending.waiter.resume(with: result)
    }

    /// Launches the host and waits (bounded) for its own ready line with the expected URL.
    @discardableResult
    public func start(timeout: Duration = .seconds(20), unlockPassword: LocalHostUnlockPassword? = nil,
                      appClientUnlockPassword: LocalHostUnlockPassword? = nil) async -> LocalHostState {
        defer { unlockPassword?.clear(); appClientUnlockPassword?.clear() }
        guard !Task.isCancelled, child == nil, state == .idle || state == .stopped || isFailed else { return state }
        guard configuration.localDeviceCustody == nil || unlockPassword != nil else { state = .failed(.deviceUnlockRequired); return state }
        guard configuration.appClientChannel == nil || appClientUnlockPassword != nil else { state = .failed(.deviceUnlockRequired); return state }
        if let failure = configuration.validate() { state = .failed(failure); return state }
        guard portIsFree(configuration.port) else { state = .failed(.portInUse(configuration.port)); return state }

        state = .starting
        memoryBackendLifetime = UUID()
        let lifetime = memoryBackendLifetime
        stdoutBuffer = Data(); stderrTail = Data(); exited = false; rejection = nil
        browserUseReadyHostID = nil; confirmedOwnerID = nil; browserUseAckBuffer = Data(); localDeviceChannelAddress = nil
        let child = makeChild(configuration, Self.childEnvironment(path: configuration.childPath))
        self.child = child
        do {
            try Task.checkCancellation()
            if configuration.localDeviceCustody != nil { try unlockPassword?.handoff(to: child) }
            if configuration.appClientChannel != nil { try appClientUnlockPassword?.handoff(to: child) }
            try Task.checkCancellation()
            try child.run(
                onStdout: { [weak self] data in Task { @MainActor in guard let self, self.memoryBackendLifetime == lifetime else { return }; self.receiveStdout(data) } },
                onStderr: { [weak self] data in Task { @MainActor in guard let self, self.memoryBackendLifetime == lifetime else { return }; self.receiveStderr(data) } },
                onExit: { [weak self] in Task { @MainActor in guard let self, self.memoryBackendLifetime == lifetime else { return }; self.childExited() } }
            )
        } catch {
            self.child = nil
            state = .failed(.launchFailed)
            return state
        }

        let timer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: timeout)
            self?.resumeReady()
        }
        if state == .starting {
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    readyWaiter = continuation
                    if Task.isCancelled { rejection = .launchFailed; resumeReady() }
                }
            } onCancel: {
                Task { @MainActor [weak self] in
                    guard let self, self.memoryBackendLifetime == lifetime, self.state == .starting else { return }
                    self.rejection = .launchFailed; self.resumeReady()
                }
            }
        }
        timer.cancel()
        if Task.isCancelled, ownsLiveChild {
            state = .stopping
            _ = await stopOwnedChild(grace: .seconds(10), finalOnSuccess: .failed(.launchFailed))
            return state
        }

        if state == .starting, rejection == nil { rejection = .startupTimedOut }
        // Cleanup stays inside start() (and joins any stop already in progress) so it cannot be orphaned.
        if state == .starting, let failure = rejection {
            state = .stopping
            _ = await stopOwnedChild(grace: .seconds(10), finalOnSuccess: .failed(failure))
        }
        return state
    }

    /// Graceful stop of the owned child only. No SIGKILL: an incomplete host shutdown keeps its lease.
    @discardableResult
    public func stop(grace: Duration = .seconds(15)) async -> LocalHostState {
        guard ownsLiveChild else { return state }
        if let pending = browserUseAck { finishBrowserUseAck(id: pending.id, result: .failure(BrowserUseKeyFailure.bridgeUnconfirmed)) }
        state = .stopping
        return await stopOwnedChild(grace: grace, finalOnSuccess: .stopped)
    }

    /// Serializes graceful stops: a concurrent caller joins the stop already in flight.
    private func stopOwnedChild(grace: Duration, finalOnSuccess: LocalHostState) async -> LocalHostState {
        if let stopTask { return await stopTask.value }
        let task = Task { @MainActor in await self.stopChild(grace: grace, finalOnSuccess: finalOnSuccess) }
        stopTask = task
        let result = await task.value
        stopTask = nil
        return result
    }

    private var isFailed: Bool { if case .failed = state { return true }; return false }

    private func stopChild(grace: Duration, finalOnSuccess: LocalHostState) async -> LocalHostState {
        guard let child, !exited else { state = finalOnSuccess; return state }
        child.requestGracefulStop()
        let timer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: grace)
            self?.resumeExitWaiters()
        }
        await withCheckedContinuation { exitWaiters.append($0) }
        timer.cancel()
        state = exited ? finalOnSuccess : .stopUncertain
        return state
    }

    private func receiveStdout(_ data: Data) {
        if isRunning { receiveBrowserUseAck(data); return }
        guard state == .starting, rejection == nil else { return } // otherwise drained and discarded
        stdoutBuffer.append(data)
        if stdoutBuffer.count > Self.bufferCap { stdoutBuffer.removeAll() }
        // Ready is pretty-printed JSON; parse once the buffer holds one complete object.
        guard let object = try? JSONSerialization.jsonObject(with: stdoutBuffer) as? [String: Any] else { return }
        stdoutBuffer.removeAll()
        // The first complete object must be the exact ready contract; anything else fails closed and
        // start() performs the owned-child cleanup.
        let expectedEngines = configuration.enableEngines ? "enabled" : "disabled"
        let expectedMcp = configuration.enableMcp ? "enabled" : "disabled"
        let expectedDeviceTools = configuration.localDeviceCustody?.allowsDeviceTools == true ? "enabled" : "disabled"
        let channel = object["deviceChannel"] as? [String: Any]
        let deviceChannelMatches: Bool
        if configuration.localDeviceCustody != nil,
           channel?["status"] as? String == "listening", let raw = channel?["url"] as? String,
           let url = URLComponents(string: raw), url.scheme == "https", url.host == "127.0.0.1",
           let port = url.port, (1...65535).contains(port), url.user == nil, url.password == nil,
           url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" {
            deviceChannelMatches = true
        } else {
            deviceChannelMatches = configuration.localDeviceCustody == nil && channel?["status"] as? String == "unconfigured" && channel?["url"] == nil
        }
        if object["status"] as? String == "ready", object["mode"] as? String == "local-development",
           object["url"] as? String == configuration.hostAddress, object["engineExecution"] as? String == expectedEngines,
           object["mcpGateway"] as? String == expectedMcp, object["deviceTurnTools"] as? String == expectedDeviceTools,
           deviceChannelMatches,
           configuration.appClientChannel == nil || ((object["appClientChannel"] as? [String: Any])?["status"] as? String == "listening"
               && (object["appClientChannel"] as? [String: Any])?["url"] as? String == configuration.appClientChannel?.origin
               && object["hostId"] as? String == configuration.appClientChannel?.installationID
               && object["ownerId"] as? String == configuration.appClientChannel?.ownerID) {
            state = .running(address: configuration.hostAddress)
            localDeviceChannelAddress = configuration.localDeviceCustody == nil ? nil : channel?["url"] as? String
            if let hostID = object["hostId"] as? String, !hostID.isEmpty, hostID.utf8.count <= 128,
               !hostID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) {
                browserUseReadyHostID = hostID
                if let ownerID = object["ownerId"] as? String, LocalAppClientChannelConfiguration.isIdentity(ownerID) { confirmedOwnerID = ownerID }
                openMcpOAuthCustody(hostID: hostID)
            }
        } else {
            rejection = .readyContractMismatch
        }
        resumeReady()
    }

    private func receiveBrowserUseAck(_ data: Data) {
        guard configuration.browserUsePrivateInput else { return }
        browserUseAckBuffer.append(data)
        guard browserUseAckBuffer.count <= Self.bufferCap else { browserUseAckBuffer.removeAll(); return }
        while let end = browserUseAckBuffer.firstIndex(of: 0x0a) {
            let line = browserUseAckBuffer[..<end]
            browserUseAckBuffer.removeSubrange(...end)
            if line.count <= 16_384, let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String:Any],
               object["schema"] as? String == "dexter.memory-backend-key-ack/1" { receiveMemoryBackendAck(object); continue }
            if line.count <= 16_384, let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String:Any],
               object["schema"] as? String == ConnectionsPrivateFrame.ackSchema { receiveConnectionsAck(object); continue }
            if line.count <= 16_384, let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String:Any],
               object["schema"] as? String == McpOAuthCustodyResponder.requestSchema { receiveMcpOAuthCustodyRequest(object); continue }
            guard line.count <= 16_384, let pending = browserUseAck,
                  let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  Set(object.keys) == ["schema", "requestId", "hostID", "status"] || Set(object.keys) == ["schema", "requestId", "hostID", "status", "code"],
                  object["schema"] as? String == "dexter.browser-use-key-ack/1",
                  object["requestId"] as? String == pending.id, object["hostID"] as? String == pending.hostID,
                  browserUseReadyHostID == pending.hostID, let status = object["status"] as? String,
                  ["ready", "locked", "refused"].contains(status) else { continue }
            let expected = pending.operation == "set" ? "ready" : "locked"
            finishBrowserUseAck(id: pending.id, result: status == expected ? .success(()) : .failure(BrowserUseKeyFailure.bridgeUnconfirmed))
        }
    }

    /// UX-P1-10: opens custody for the exact owned child right after its ready object was parsed (no secret in the frame).
    private func openMcpOAuthCustody(hostID: String) {
        guard mcpOAuthCustody != nil, let child, child.isRunning, let frame = McpOAuthCustodyResponder.openFrame(hostID: hostID) else { return }
        try? child.provideMcpOAuthCustodyFrame(frame)
    }

    /// Only the exact owned child (ready host identity) is answered; nothing is logged; the frame is wiped after the write.
    private func receiveMcpOAuthCustodyRequest(_ object: [String: Any]) {
        guard isRunning, let hostID = browserUseReadyHostID, let responder = mcpOAuthCustody, let child, child.isRunning,
              var frame = responder.respond(to: object, readyHostID: hostID) else { return }
        defer { frame.resetBytes(in: 0..<frame.count) }
        try? child.provideMcpOAuthCustodyFrame(frame)
    }

    private func receiveStderr(_ data: Data) {
        stderrTail.append(data)
        if stderrTail.count > 4096 { stderrTail = stderrTail.suffix(4096) }
    }

    private func childExited() {
        if let pending = memoryBackendAck { finishMemoryBackendAck(pending.intent.requestID, result: .failure(MemoryBackendPrivateFailure.outcomeUnknown)) }
        if let pending = connectionsAck { finishConnectionsAck(pending.intent.requestID, result: .failure(ConnectionsPrivateFailure.outcomeUnknown)) }
        if let pending = browserUseAck { finishBrowserUseAck(id: pending.id, result: .failure(BrowserUseKeyFailure.bridgeUnconfirmed)) }
        browserUseReadyHostID = nil; confirmedOwnerID = nil; browserUseAckBuffer.removeAll()
        exited = true
        let code = child?.terminationStatus ?? -1
        switch state {
        case .starting: state = .failed(.exitedBeforeReady(code: code, hint: Self.hint(from: stderrTail)))
        case .running:
            state = .failed(.exitedAfterReady(code: code))
            onUnexpectedExit?(.exitedAfterReady(code: code))
        default: break
        }
        stderrTail = Data()
        child = nil
        resumeReady()
        resumeExitWaiters()
    }

    private func resumeReady() { readyWaiter?.resume(); readyWaiter = nil }
    private func resumeExitWaiters() { let waiters = exitWaiters; exitWaiters = []; waiters.forEach { $0.resume() } }

    /// Maps known host diagnostics to fixed text; nothing from stderr is echoed.
    static func hint(from stderr: Data) -> String? {
        let text = String(decoding: stderr, as: UTF8.self)
        if text.contains("Host listener failed") { return String(localized: "The port could not be opened.") }
        if text.contains("Host shutdown incomplete") { return String(localized: "Shutdown was incomplete; the store and writer lease were retained.") }
        if text.contains("conflict:") { return String(localized: "The store is in use or not in a startable state.") }
        if text.contains("invalid_input:") { return String(localized: "The host rejected its arguments.") }
        if text.contains("ERR_MODULE_NOT_FOUND") || text.contains("Cannot find module") { return String(localized: "Host build output is incomplete; rebuild packages.") }
        return nil
    }

    /// Inherit the environment minus the launch keys and any secret the host would consume. A controlled
    /// PATH (packaged local engines only) replaces the inherited one; no other variable is added.
    static func childEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment, path: String? = nil) -> [String: String] {
        var result = env.filter { key, _ in !key.hasPrefix("DEXTER_LOCAL_HOST_") && key != "DEXTER_AI_MEMORY_USER_KEY" }
        if let path { result["PATH"] = path }
        return result
    }

    /// Bind probe on 127.0.0.1. Only a hint before launch; the host's own listener remains authoritative.
    nonisolated public static func loopbackPortIsFree(_ port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        // Match the host listener's address reuse: recently closed HTTP connections may still be in
        // TIME_WAIT after our child exits. This does not permit sharing an active listener (no REUSEPORT).
        var reuseAddress: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuseAddress, socklen_t(MemoryLayout<Int32>.size)) == 0 else { return false }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
        }
    }
}

/// Decides whether the app's current connection selection permits starting a local writer.
/// Uses only public model state; refuses for demo/fixture, any paired/remote selection, or a
/// different loopback address. It never changes the selection itself.
@MainActor
public enum LocalHostStartupGate {
    public static func permits(_ model: DexterAppModel, configuration: LocalHostLaunchConfiguration) -> Bool {
        guard !model.isFixture, !model.remotePairingPending, !model.requiresStorageReset,
              model.pairing.publicReference == nil, model.pairing.state == .disconnected else { return false }
        return DexterAppStateValidation.validatedLoopbackAddress(model.hostAddress) == configuration.hostAddress
            && model.canUseHost
    }
}
/// Outcome of an explicit Settings Apply. Messages are fixed English catalog keys; paths are never echoed.
public enum LocalEngineApplyRefusal: Error, Equatable, Sendable {
    /// Not a validly packaged bundle (or the developer environment override is active).
    case unavailable
    /// The launch's startup attempt or another Apply is still running.
    case busy
    /// The current connection is not this app's own packaged loopback host.
    case notThisHost
    /// A message is being sent or a reply is running; the host is not interrupted.
    case conversationActive
    case invalidChoice(LocalEngineActivationIssue)
    case saveFailed
    case unlockRequired
    case quitting
    case quittingAfterSave
    case choiceChanged
    /// Saved. The previous host did not confirm its stop; nothing new was started while it may still write.
    case stopUncertain
    /// Saved. The selection, the saved choice or the files changed while applying; the result was discarded.
    case changedWhileApplying
    /// Saved. The new local host did not start.
    case startFailed(LocalHostFailure)

    /// True when the choice was persisted (it still applies at the next opening).
    public var preferenceSaved: Bool {
        switch self {
        case .stopUncertain, .changedWhileApplying, .startFailed, .quittingAfterSave: true
        default: false
        }
    }

    public var message: String {
        switch self {
        case .unavailable: "Local Claude/Codex can only be applied to this app's own packaged local host."
        case .busy: "The local host is still starting or applying a change. Try again when it finishes."
        case .notThisHost: "The app is not connected to its own local host, so nothing was applied. Select the local host first."
        case .conversationActive: "A message or reply is in progress. Apply again after it finishes; nothing was interrupted."
        case .invalidChoice(let issue): issue.message
        case .saveFailed: "The choice could not be saved; nothing was changed."
        case .unlockRequired: LocalHostFailure.deviceUnlockRequired.message
        case .quitting: "Dexter is quitting; nothing was applied."
        case .quittingAfterSave: String(localized: "A escolha foi salva, mas o Dexter está fechando. Ela será conferida na próxima abertura.")
        case .choiceChanged: String(localized: "A escolha salva mudou. Nada foi aplicado; abra Preparar novamente.")
        case .stopUncertain: "Saved, but the local host did not confirm it stopped. Nothing new was started; quit and reopen Dexter to apply."
        case .changedWhileApplying: "Saved, but the connection or files changed while applying. Nothing else was started; apply again or reopen Dexter."
        case .startFailed(let failure): failure.message
        }
    }
}

public enum LocalEngineApplyPhase: Equatable, Sendable {
    case idle
    case applying
    case applied
    case refused(LocalEngineApplyRefusal)
}

/// App-level glue: one attempt per launch, only when explicitly configured and the current
/// connection selection is this loopback host. Owns the Mac window's initial refresh so a refresh
/// cannot race the host coming up. Failures go to the model's existing error surface.
@Observable @MainActor
public final class LocalHostLaunchCoordinator {
    public private(set) var supervisor: LocalHostSupervisor?
    @ObservationIgnored private var memoryBackendEditors: [String: MemoryBackendSettingsEditor] = [:]
    @ObservationIgnored private var connectionsPlatformControllers: [String: ConnectionsPlatformSettingsController] = [:]
    @ObservationIgnored private var assistantSetupControllers: [String: AssistantSetupController] = [:]
    @ObservationIgnored private var attempt: Task<Bool, Never>?
    @ObservationIgnored private let configuration: Result<LocalHostLaunchConfiguration, LocalHostFailure>?
    /// The valid packaged configuration before the Settings choice; nil for the developer override.
    @ObservationIgnored private let packaged: LocalHostLaunchConfiguration?
    /// Set only when applying the saved Settings choice to the packaged configuration failed; its error is
    /// delivered only while the selection is this packaged loopback host.
    @ObservationIgnored private let preferenceFailureBase: LocalHostLaunchConfiguration?
    @ObservationIgnored private let enginePreferences: LocalEnginePreferenceStore
    @ObservationIgnored private let makeSupervisor: @MainActor (LocalHostLaunchConfiguration) -> LocalHostSupervisor
    @ObservationIgnored private let applyStopGrace: Duration
    @ObservationIgnored private let unlockStore: (any LocalHostUnlockStore)?
    @ObservationIgnored private let unlockBundleID: String
    @ObservationIgnored private let appClientPreferences: LocalAppClientChannelPreferences
    @ObservationIgnored private let appClientAddresses: @MainActor () -> [String]
    @ObservationIgnored private var macSetupControllers: [String: MacAutoSetupController] = [:]
    @ObservationIgnored private var automaticMacAttemptFinished = false
    @ObservationIgnored private var initialAttemptFinished = false
    public private(set) var appClientPreparationBusy = false
    /// Display-only result of the optional channel, separate from the applied engine/device choice.
    public private(set) var appClientChannelNotice: String?
    @ObservationIgnored private var terminating = false
    /// Fixed at launch (compatibility). The live state is `currentEngineConfiguration`.
    public let enginesEnabledThisLaunch: Bool
    /// Serial state of the explicit Settings Apply; `.applying` refuses another Apply.
    public private(set) var applyPhase: LocalEngineApplyPhase = .idle

    /// The per-process environment stays a developer override (including its explicit engine choice);
    /// otherwise only a bundle explicitly packaged for local development arms the attempt (so a
    /// Finder/Dock launch needs no shell env), with the saved local-engine choice applied to it.
    public init(environment: [String: String] = ProcessInfo.processInfo.environment, bundle: Bundle = .main,
                enginePreferences: LocalEnginePreferenceStore? = nil) {
        let store = enginePreferences ?? LocalEnginePreferenceStore()
        self.enginePreferences = store
        appClientPreferences = LocalAppClientChannelPreferences()
        appClientAddresses = LocalAppClientChannelConfiguration.currentAddresses
        unlockStore = NativeLocalHostUnlockStore(); unlockBundleID = bundle.bundleIdentifier ?? ""
        makeSupervisor = { LocalHostSupervisor(configuration: $0) }
        applyStopGrace = .seconds(15)
        if let developer = LocalHostLaunchConfiguration.fromEnvironment(environment) {
            configuration = developer
            packaged = nil
            preferenceFailureBase = nil
        } else if let bundled = LocalHostLaunchConfiguration.fromBundle(bundle) {
            let base = try? bundled.get()
            packaged = base
            let applied = bundled.flatMap { $0.applyingLocalEnginePreference(store.load()) }
            configuration = applied
            if let base, case .failure = applied { preferenceFailureBase = base } else { preferenceFailureBase = nil }
        } else {
            configuration = nil
            packaged = nil
            preferenceFailureBase = nil
        }
        enginesEnabledThisLaunch = (try? configuration?.get())?.enableEngines ?? false
    }

    /// Test seam: a packaged configuration with the saved choice applied, and injected supervisors.
    init(packaged base: LocalHostLaunchConfiguration, enginePreferences store: LocalEnginePreferenceStore,
         makeSupervisor: @escaping @MainActor (LocalHostLaunchConfiguration) -> LocalHostSupervisor, stopGrace: Duration = .seconds(15), unlockStore: (any LocalHostUnlockStore)? = nil, bundleID: String = "com.dexter.tests",
         appClientAddresses: @escaping @MainActor () -> [String] = LocalAppClientChannelConfiguration.currentAddresses,
         appClientDefaults: UserDefaults? = nil, appClientCustodyRoot: URL? = nil) {
        enginePreferences = store
        appClientPreferences = LocalAppClientChannelPreferences(defaults: appClientDefaults ?? UserDefaults(suiteName: "com.dexter.app-client-tests." + UUID().uuidString)!, root: appClientCustodyRoot)
        self.appClientAddresses = appClientAddresses
        self.makeSupervisor = makeSupervisor
        self.unlockStore = unlockStore; unlockBundleID = bundleID
        applyStopGrace = stopGrace
        packaged = base
        let applied = base.applyingLocalEnginePreference(store.load())
        configuration = applied
        if case .failure = applied { preferenceFailureBase = base } else { preferenceFailureBase = nil }
        enginesEnabledThisLaunch = (try? applied.get())?.enableEngines ?? false
    }

    public var isConfigured: Bool { configuration != nil }

    /// Loopback address of the base this app starts on this Mac (packaged or developer override), whether or not it
    /// is running. Storage recovery reconnects here instead of the demo fixture. Never a paired or remote address.
    public var launchHostAddress: String? { ((try? configuration?.get()) ?? packaged)?.hostAddress }

    /// Settings offers the local-engine choice only for a validly packaged bundle without a developer override.
    public var acceptsLocalEnginePreference: Bool { packaged != nil }

    public func loadLocalEnginePreference() -> LocalEngineStoredPreference { enginePreferences.load() }

    /// Filesystem-only check of a draft against this bundle; nil when the choice does not apply.
    public func previewLocalEngineActivation(_ preference: LocalEnginePreference) -> Result<LocalEngineActivationPlan, LocalEngineActivationIssue>? {
        packaged?.localEngineActivation(preference)
    }

    /// Compatibility: persists the explicit choice for the next opening only. Nothing is restarted or
    /// retried; an allowing choice is saved only when it validates now. Settings uses Apply instead.
    @discardableResult
    public func saveLocalEnginePreference(_ preference: LocalEnginePreference) -> Bool {
        guard let packaged else { return false }
        if preference.allowsLocalEngines, case .failure = packaged.localEngineActivation(preference) { return false }
        return enginePreferences.save(preference)
    }
    public var ownsLiveChild: Bool { supervisor?.ownsLiveChild ?? false }
    public var confirmedOwnedHostID: String? { supervisor?.confirmedHostID }

    public func canManageBrowserUseKey(model: DexterAppModel, hostID: String) -> Bool {
        guard !terminating, let supervisor, model.browserUseHostID == hostID,
              LocalHostStartupGate.permits(model, configuration: supervisor.configuration) else { return false }
        return supervisor.canManageBrowserUseKey(hostID: hostID)
    }

    public func setBrowserUseKey(_ key: String?, model: DexterAppModel, hostID: String) async throws {
        guard canManageBrowserUseKey(model: model, hostID: hostID), let supervisor else { throw BrowserUseKeyFailure.bridgeUnavailable }
        try await supervisor.setBrowserUseKey(key, hostID: hostID)
        guard self.supervisor === supervisor, canManageBrowserUseKey(model: model, hostID: hostID) else { throw BrowserUseKeyFailure.bridgeUnconfirmed }
    }

    public func canManageMemoryBackend(model: DexterAppModel, hostID: String) -> Bool {
        guard !terminating, let supervisor, model.browserUseHostID == hostID,
              LocalHostStartupGate.permits(model, configuration: supervisor.configuration) else { return false }
        return supervisor.canManageMemoryBackend(hostID: hostID)
    }
    public func sendMemoryBackendFrame(_ frame: MemoryBackendPrivateFrame, model: DexterAppModel) async throws {
        guard canManageMemoryBackend(model: model, hostID: frame.intent.scope.hostID), let supervisor else { frame.clear(); throw MemoryBackendPrivateFailure.bridgeUnavailable }
        try await supervisor.sendMemoryBackendFrame(frame)
        guard self.supervisor === supervisor, canManageMemoryBackend(model:model,hostID:frame.intent.scope.hostID) else { throw MemoryBackendPrivateFailure.outcomeUnknown }
    }
    @discardableResult public func reconcileMemoryBackend(_ intent: MemoryBackendPrivateIntent, status: MemoryBackendStatus, model: DexterAppModel) -> Bool {
        guard canManageMemoryBackend(model:model,hostID:intent.scope.hostID), let supervisor else { return false }
        return supervisor.reconcileMemoryBackend(intent,status:status)
    }
    /// Retains public intentions across Settings closes, bound to the exact model generation and owned child.
    public func makeMemoryBackendEditor(model: DexterAppModel) -> MemoryBackendSettingsEditor? {
        guard let owned = supervisor, let hostID = model.browserUseHostID, model.isOnline, let client = model.makeLocalMcpClient() else { return nil }
        let context = model.nativeComposerScope, address = model.hostAddress
        let lifetime = owned.memoryBackendLifetime
        let key = hostID + ":" + context.uuidString + ":" + address + ":" + lifetime.uuidString
        if let retained = memoryBackendEditors[key] { client.close(); return retained }
        guard memoryBackendEditors.count < 128 else { client.close(); return nil }
        let editor = MemoryBackendSettingsEditor(hostID:hostID,client:client,isCurrent:{ [weak self, weak owned, weak model] in
            guard let self, let owned, let model, self.supervisor === owned, owned.memoryBackendLifetime == lifetime else { return false }
            return model.isOnline && model.canEditBotProfiles && model.nativeComposerScope == context
                && model.hostAddress == address && model.browserUseHostID == hostID
        },channel:MemoryBackendPrivateChannel(available:{ [weak self, weak model] host in
            guard let self, let model else { return false }; return self.canManageMemoryBackend(model:model,hostID:host)
        },send:{ [weak self, weak model] frame in
            guard let self, let model else { frame.clear(); throw MemoryBackendPrivateFailure.bridgeUnavailable }
            try await self.sendMemoryBackendFrame(frame,model:model)
        },reconcile:{ [weak self, weak model] intent, status in
            guard let self, let model else { return false }; return self.reconcileMemoryBackend(intent,status:status,model:model)
        },uncertain:{ [weak self] in self?.supervisor?.unconfirmedMemoryBackendIntent }),wrapping:NativeScopedWrappingKeychain())
        memoryBackendEditors[key] = editor; return editor
    }
    public func canManageConnectionsPlatform(model: DexterAppModel, hostID: String) -> Bool {
        guard !terminating, let supervisor, model.browserUseHostID == hostID,
              LocalHostStartupGate.permits(model, configuration: supervisor.configuration) else { return false }
        return supervisor.canManageConnectionsPlatform(hostID: hostID)
    }
    public func sendConnectionsCapabilityFrame(_ frame: ConnectionsPrivateFrame, model: DexterAppModel) async throws {
        guard canManageConnectionsPlatform(model: model, hostID: frame.intent.scope.hostID), let supervisor else { frame.clear(); throw ConnectionsPrivateFailure.bridgeUnavailable }
        try await supervisor.sendConnectionsCapabilityFrame(frame)
        guard self.supervisor === supervisor, canManageConnectionsPlatform(model: model, hostID: frame.intent.scope.hostID) else { throw ConnectionsPrivateFailure.outcomeUnknown }
    }
    @discardableResult public func reconcileConnectionsCapability(_ intent: ConnectionsPrivateIntent, status: ConnectionsConfigurationStatus, model: DexterAppModel) -> Bool {
        guard canManageConnectionsPlatform(model: model, hostID: intent.scope.hostID), let supervisor else { return false }
        return supervisor.reconcileConnectionsCapability(intent, status: status)
    }
    /// Owner-private connections service settings of THIS Mac's own host: retained per host/scope/address/child lifetime,
    /// bound to the owned child's private pipe and the signed Keychain custody. nil without a confirmed own host.
    public func makeConnectionsPlatformController(model: DexterAppModel, store: (any ConnectionsCapabilityStore)? = nil) -> ConnectionsPlatformSettingsController? {
        guard let owned = supervisor, let hostID = model.browserUseHostID, model.isOnline, let client = model.makeLocalMcpClient() else { return nil }
        let context = model.nativeComposerScope, address = model.hostAddress, lifetime = owned.memoryBackendLifetime
        let key = hostID + ":" + context.uuidString + ":" + address + ":" + lifetime.uuidString
        if let retained = connectionsPlatformControllers[key] { client.close(); return retained }
        guard connectionsPlatformControllers.count < 128 else { client.close(); return nil }
        let controller = ConnectionsPlatformSettingsController(hostID: hostID, client: client, isCurrent: { [weak self, weak owned, weak model] in
            guard let self, let owned, let model, self.supervisor === owned, owned.memoryBackendLifetime == lifetime else { return false }
            return model.isOnline && model.canEditBotProfiles && model.nativeComposerScope == context && model.hostAddress == address && model.browserUseHostID == hostID
        }, channel: ConnectionsPrivateChannel(available: { [weak self, weak model] host in
            guard let self, let model else { return false }; return self.canManageConnectionsPlatform(model: model, hostID: host)
        }, send: { [weak self, weak model] frame in
            guard let self, let model else { frame.clear(); throw ConnectionsPrivateFailure.bridgeUnavailable }
            try await self.sendConnectionsCapabilityFrame(frame, model: model)
        }, reconcile: { [weak self, weak model] intent, status in
            guard let self, let model else { return false }; return self.reconcileConnectionsCapability(intent, status: status, model: model)
        }, uncertain: { [weak self] in self?.supervisor?.unconfirmedConnectionsIntent }), store: store ?? NativeScopedConnectionsCapabilityKeychain())
        connectionsPlatformControllers[key] = controller; return controller
    }
    /// The configuration of the owned host only while it is confirmed running (ready contract matched,
    /// engines and tool gateway included); nil otherwise. This, not the saved draft, is what is applied now.
    public var currentEngineConfiguration: LocalHostLaunchConfiguration? {
        guard let supervisor, supervisor.isRunning else { return nil }
        return supervisor.configuration
    }

    /// Explicit Apply from Settings: validates and persists the choice, then, only while the selection is
    /// this app's own packaged loopback host, gracefully stops the owned host (never another process),
    /// waits for its exit and starts the packaged host again with the new choice. Never retries; an
    /// uncertain stop refuses the restart. Pending sends, identity and pairing are not touched.
    @discardableResult
    public func applyLocalEnginePreference(_ preference: LocalEnginePreference, model: DexterAppModel, unlockPassword: LocalHostUnlockPassword? = nil,
        expectedPreference: LocalEngineStoredPreference? = nil, verifyRuntime: (@MainActor () -> Bool)? = nil,
        custodyAction: LocalDeviceCustodyAction = .unlock) async -> LocalEngineApplyPhase {
        defer { unlockPassword?.clear() }
        guard applyPhase != .applying else { return applyPhase }
        applyPhase = .applying
        let outcome = await performApply(preference, model: model, unlockPassword: unlockPassword, expectedPreference: expectedPreference, verifyRuntime: verifyRuntime, custodyAction: custodyAction)
        applyPhase = outcome.map(LocalEngineApplyPhase.refused) ?? .applied
        return applyPhase
    }

    private func performApply(_ preference: LocalEnginePreference, model: DexterAppModel, unlockPassword: LocalHostUnlockPassword?, expectedPreference: LocalEngineStoredPreference?, verifyRuntime: (@MainActor () -> Bool)?, custodyAction: LocalDeviceCustodyAction) async -> LocalEngineApplyRefusal? {
        guard !appClientPreparationBusy else { return .busy }
        guard let packaged else { return .unavailable }
        guard !terminating else { return .quitting }
        guard !Task.isCancelled else { return .choiceChanged }
        guard initialAttemptFinished, supervisor?.state != .starting, supervisor?.state != .stopping else { return .busy }
        guard LocalHostStartupGate.permits(model, configuration: packaged) else { return .notThisHost }
        guard !conversationActive(model) else { return .conversationActive }
        guard expectedPreference == nil || enginePreferences.load() == expectedPreference else { return .choiceChanged }
        guard verifyRuntime?() != false else { return .choiceChanged }
        let selectedScope = model.filesScope
        var next: LocalHostLaunchConfiguration
        switch planApply(preference, packaged: packaged, custodyAction: custodyAction) {
        case .failure(let refusal): return refusal
        case .success(let config): next = config
        }
        // Already running exactly this choice: nothing to restart.
        if let current = currentEngineConfiguration,
           current.requiringCustodyAction(.unlock).withAppClientChannel(nil) == next.requiringCustodyAction(.unlock).withAppClientChannel(nil) {
            return enginePreferences.save(preference) ? nil : .saveFailed
        }
        let effectiveUnlock = unlockPassword ?? authorizedDeviceUnlock(preference)
        defer { effectiveUnlock?.clear() }
        guard next.localDeviceCustody == nil || effectiveUnlock != nil else { return .unlockRequired }
        let appClientUnlock: LocalHostUnlockPassword?
        var optionalChannelUnavailable = optionalAppClientNeedsRepair(next)
        do { appClientUnlock = try appClientPassword(next) }
        catch {
            next = next.withAppClientChannel(nil); appClientUnlock = nil; optionalChannelUnavailable = true
        }
        defer { appClientUnlock?.clear() }
        guard !Task.isCancelled, verifyRuntime?() != false else { return .choiceChanged }
        guard enginePreferences.save(preference) else { return .saveFailed }

        if let previous = supervisor, previous.ownsLiveChild {
            let stopped = await previous.stop(grace: applyStopGrace)
            if stopped == .stopUncertain || previous.ownsLiveChild { return .stopUncertain }
        }
        // Everything is re-checked after the await: quitting, selection, saved choice and files.
        guard !terminating else { return .quittingAfterSave }
        guard !Task.isCancelled, model.filesScope == selectedScope, verifyRuntime?() != false, LocalHostStartupGate.permits(model, configuration: packaged), !conversationActive(model),
              enginePreferences.load() == .saved(preference),
              case .success(let recheck) = planApply(preference, packaged: packaged, custodyAction: custodyAction),
              (next.appClientChannel == nil ? recheck.withAppClientChannel(nil) == next : recheck == next) else {
            await model.refresh()
            return .changedWhileApplying
        }
        if let failure = next.prepareDataParent() { return .startFailed(failure) }
        if let failure = next.prepareSelectedEngineBindings() { return .startFailed(failure) }
        if let failure = next.prepareDeviceCustodyParent() { return .startFailed(failure) }
        let supervisor = makeSupervisor(next)
        supervisor.onUnexpectedExit = { [weak model] failure in
            guard let model, LocalHostStartupGate.permits(model, configuration: next) else { return }
            model.errorMessage = failure.message
        }
        self.supervisor = supervisor
        let result = await supervisor.start(unlockPassword: effectiveUnlock, appClientUnlockPassword: appClientUnlock)
        guard !terminating, !Task.isCancelled, verifyRuntime?() != false,
              enginePreferences.load() == .saved(preference), model.filesScope == selectedScope,
              LocalHostStartupGate.permits(model, configuration: next) else {
            if supervisor.ownsLiveChild { await supervisor.stop() }
            await model.refresh()
            return terminating ? .quittingAfterSave : .changedWhileApplying
        }
        switch result {
        case .running:
            deactivateObsoleteChannelIfNeeded(config: next, hostID: supervisor.confirmedHostID, ownerID: supervisor.confirmedOwnerID)
            await model.refresh()
            if optionalChannelUnavailable { reportOptionalChannelUnavailable(model) }
            return nil
        case .failed(let failure):
            if await restoreLocalChatAfterAppClientFailure(supervisor, model: model, generation: selectedScope) { return nil }
            return .startFailed(failure)
        case .stopUncertain:
            return .stopUncertain
        default:
            return .startFailed(.launchFailed)
        }
    }

    /// The packaged configuration with the choice applied; an allowing choice must validate on disk now.
    private func planApply(_ preference: LocalEnginePreference, packaged: LocalHostLaunchConfiguration, custodyAction: LocalDeviceCustodyAction = .unlock) -> Result<LocalHostLaunchConfiguration, LocalEngineApplyRefusal> {
        guard preference.isWellFormed else { return .failure(.saveFailed) }
        if preference.allowsLocalEngines, case .failure(let issue) = packaged.localEngineActivation(preference) {
            return .failure(.invalidChoice(issue))
        }
        switch packaged.applyingLocalEnginePreference(.saved(preference), includeDeviceChannel: true, custodyAction: custodyAction) {
        case .success(let config):
            return .success((try? restoredAppClientConfiguration(config)) ?? config.withAppClientChannel(nil))
        case .failure: return .failure(.invalidChoice(.noEngineSelected))
        }
    }

    /// True when the owned host is running exactly what this choice would apply now (filesystem-only check).
    public func isCurrentlyApplied(_ preference: LocalEnginePreference) -> Bool {
        guard let packaged, let current = currentEngineConfiguration,
              case .success(let planned) = planApply(preference, packaged: packaged) else { return false }
        return planned.requiringCustodyAction(.unlock).withAppClientChannel(nil) == current.requiringCustodyAction(.unlock).withAppClientChannel(nil)
    }

    public func needsDeviceChannelUnlock(_ preference: LocalEnginePreference) -> Bool {
        preference.allowsLocalEngines && preference.allowsDexterTools && preference.localDeviceCustody != nil && !isCurrentlyApplied(preference) && deviceUnlockStatus(preference) != .configured
    }

    private func unlockScope(_ preference: LocalEnginePreference) -> LocalHostUnlockScope? {
        guard let path = preference.localDeviceCustody?.filePath else { return nil }
        return try? LocalHostUnlockScope(bundleID: unlockBundleID, custodyFilePath: path)
    }
    private func deviceUnlockStatus(_ preference: LocalEnginePreference) -> LocalHostUnlockStatus? {
        guard let scope = unlockScope(preference), let unlockStore else { return nil }
        return unlockStore.status(scope: scope)
    }
    private func authorizedDeviceUnlock(_ preference: LocalEnginePreference) -> LocalHostUnlockPassword? {
        guard let scope = unlockScope(preference), let unlockStore, unlockStore.status(scope: scope) == .configured,
              let bytes = try? unlockStore.load(scope: scope) else { return nil }
        return try? LocalHostUnlockPassword(ownedBytes: bytes)
    }
    /// Startup loads an already-authorized exact app/file item only. Missing, partial, legacy, unsigned,
    /// locked and remote state never create/repair anything and keep the normal conversation startup.
    private func restoredStartup(_ initial: Result<LocalHostLaunchConfiguration, LocalHostFailure>, model: DexterAppModel)
        -> (Result<LocalHostLaunchConfiguration, LocalHostFailure>, LocalHostUnlockPassword?) {
        guard let packaged, case .success = initial, LocalHostStartupGate.permits(model, configuration: packaged),
              case .saved(let preference) = enginePreferences.load(), preference.allowsLocalEngines, preference.allowsDexterTools,
              preference.localDeviceCustody != nil,
              case .success(let configured) = packaged.applyingLocalEnginePreference(.saved(preference), includeDeviceChannel: true),
              let password = authorizedDeviceUnlock(preference) else { return (initial, nil) }
        return (.success(configured), password)
    }
    public func manualDeviceCustodyAction(_ preference: LocalEnginePreference) -> LocalDeviceCustodyAction {
        guard let scope = unlockScope(preference), (try? scope.fileState()) == .absent else { return .unlock }
        return .create
    }
    /// Public status only. An incomplete creation can be resumed by its reviewed ID, never automatically.
    public func pendingDeviceChannelCreationID() -> String? {
        guard let unlockStore, let preference = deviceSetupPreference(), let scope = unlockScope(preference),
              unlockStore.status(scope: scope) == .blocked,
              (try? scope.fileState()) == .absent else { return nil }
        return try? unlockStore.creationInfo(scope: scope)?.creationId
    }
    private func deviceSetupPreference() -> LocalEnginePreference? {
        guard case .saved(var preference) = enginePreferences.load(), preference.allowsLocalEngines else { return nil }
        preference.allowsDexterTools = true
        if preference.localDeviceCustody == nil {
            guard let path = LocalDeviceCustodyPreference.defaultFilePath else { return nil }
            preference.localDeviceCustody = LocalDeviceCustodyPreference(filePath: path, allowsDeviceTools: true)
        } else { preference.localDeviceCustody?.allowsDeviceTools = true }
        preference.localDeviceCustody?.autostartPreparedAgent = true
        return preference
    }

    private func restoredAppClientConfiguration(_ config: LocalHostLaunchConfiguration) throws -> LocalHostLaunchConfiguration {
        if config.appClientChannel != nil { return config }
        switch appClientPreferences.load(host: config.dataDir) {
        case .missing: return config
        case .unreadable, .pending, .inactive: throw LocalAppClientPreparationFailure.custodyUnavailable
        case .saved(let address, let installationID, let ownerID, let generation):
            guard appClientAddresses().contains(address) else { throw LocalAppClientPreparationFailure.networkUnavailable }
            return config.withAppClientChannel(try appClientPreferences.configuration(address: address, host: config.dataDir,
                installationID: installationID, ownerID: ownerID, generation: generation))
        }
    }
    private func optionalAppClientNeedsRepair(_ config: LocalHostLaunchConfiguration) -> Bool {
        config.appClientChannel == nil && appClientPreferences.load(host: config.dataDir) != .missing
    }
    private func reportOptionalChannelUnavailable(_ model: DexterAppModel) {
        if appClientChannelNotice == nil {
            appClientChannelNotice = String(localized: "A conexão segura com outros aparelhos está indisponível. O chat deste Mac continua funcionando. Use Recriar conexão segura para conectar os aparelhos novamente.")
        }
        model.errorMessage = appClientChannelNotice
    }
    private func deactivateObsoleteChannelIfNeeded(config: LocalHostLaunchConfiguration, hostID: String?, ownerID: String?) {
        guard config.appClientChannel == nil, let hostID, let ownerID else { return }
        let stored = appClientPreferences.load(host: config.dataDir)
        let address: String, oldHost: String, oldOwner: String, generation: String?
        switch stored {
        case .saved(let saved, let installationID, let ownerID, let savedGeneration):
            (address, oldHost, oldOwner, generation) = (saved, installationID, ownerID, savedGeneration)
        case .pending(let saved, let installationID, let ownerID, let pendingGeneration, _):
            (address, oldHost, oldOwner, generation) = (saved, installationID, ownerID, pendingGeneration)
        default: return
        }
        guard oldHost != hostID || oldOwner != ownerID,
              let channel = try? appClientPreferences.configuration(address: address, host: config.dataDir,
                installationID: oldHost, ownerID: oldOwner, generation: generation) else { return }
        do {
            try appClientPreferences.deactivate(channel, host: config.dataDir, expected: stored)
            appClientChannelNotice = String(localized: "A base deste Mac mudou. A conexão segura anterior foi desativada; recrie a conexão para parear os aparelhos novamente.")
        } catch {
            // A concurrent metadata edit is not overwritten. Local-only chat still does not inherit its authority.
            appClientChannelNotice = String(localized: "A conexão segura precisa de revisão. Os dados salvos mudaram; nenhuma identidade foi substituída.")
        }
    }
    private func appClientPassword(_ config: LocalHostLaunchConfiguration) throws -> LocalHostUnlockPassword? {
        guard let channel = config.appClientChannel else { return nil }
        guard let unlockStore else { throw LocalAppClientPreparationFailure.custodyUnavailable }
        let scope = try LocalHostUnlockScope(bundleID: unlockBundleID, custodyFilePath: channel.custodyFile)
        guard unlockStore.status(scope: scope) == .configured else { throw LocalAppClientPreparationFailure.custodyUnavailable }
        return try LocalHostUnlockPassword(ownedBytes: unlockStore.load(scope: scope))
    }

    /// Normal startup/Apply recovery accepts a fresh local-only host just like normal startup. Saved channel
    /// identity is never a condition for local chat. Explicit preparation alone supplies BOTH captured IDs.
    private func restoreLocalChatAfterAppClientFailure(_ failed: LocalHostSupervisor, model: DexterAppModel,
        generation: String, expectedHostID: String? = nil, expectedOwnerID: String? = nil,
        afterConfirmedPreparationStop: Bool = false) async -> Bool {
        let recoverable: Bool
        if case .failed(.exitedBeforeReady) = failed.state { recoverable = failed.configuration.appClientChannel != nil }
        else { recoverable = afterConfirmedPreparationStop && failed.state == .stopped }
        guard recoverable, failed.hasConfirmedChildExit, !failed.ownsLiveChild, packaged != nil, supervisor === failed,
              !terminating, !Task.isCancelled, model.filesScope == generation,
              LocalHostStartupGate.permits(model, configuration: failed.configuration), !conversationActive(model) else { return false }
        let config = failed.configuration.requiringCustodyAction(.unlock).withAppClientChannel(nil)
        let password: LocalHostUnlockPassword?
        if let device = config.localDeviceCustody {
            guard case .saved(let preference) = enginePreferences.load(), preference.localDeviceCustody == device,
                  let loaded = authorizedDeviceUnlock(preference) else { return false }
            password = loaded
        } else { password = nil }
        defer { password?.clear() }
        let fallback = makeSupervisor(config)
        fallback.onUnexpectedExit = { [weak model] failure in
            guard let model, LocalHostStartupGate.permits(model, configuration: config) else { return }
            model.errorMessage = failure.message
        }
        supervisor = fallback
        let result = await fallback.start(unlockPassword: password)
        let expectedIdentityMatches = expectedHostID == nil && expectedOwnerID == nil
            || (expectedHostID != nil && expectedOwnerID != nil && fallback.confirmedHostID == expectedHostID && fallback.confirmedOwnerID == expectedOwnerID)
        guard !terminating, !Task.isCancelled, model.filesScope == generation,
              LocalHostStartupGate.permits(model, configuration: config), case .running = result, expectedIdentityMatches else {
            if fallback.ownsLiveChild, fallback.state != .stopUncertain { await fallback.stop(grace: applyStopGrace) }
            return false
        }
        deactivateObsoleteChannelIfNeeded(config: config, hostID: fallback.confirmedHostID, ownerID: fallback.confirmedOwnerID)
        await model.refresh()
        guard LocalHostStartupGate.permits(model, configuration: config), fallback.isRunning else { return false }
        reportOptionalChannelUnavailable(model)
        return true
    }

    public var hasPendingAppClientPreparation: Bool {
        guard let packaged else { return false }
        if case .pending = appClientPreferences.load(host: packaged.dataDir) { return true }
        return false
    }

    /// Human-only initial preparation or explicit resume of the same pending generation. Existing active
    /// custody only unlocks. Missing/blocked legacy custody never becomes a replacement certificate.
    @discardableResult public func prepareAppClientChannel(model: DexterAppModel) async throws -> LocalAppClientPreparationResult {
        try await prepareAppClientChannel(model: model, renewing: false)
    }
    /// Called only after the native confirmation. A fresh UUID selects a NEW create-only file/Keychain scope;
    /// no old ciphertext, secret or device entry is removed, overwritten or implicitly approved.
    @discardableResult public func renewAppClientChannel(model: DexterAppModel) async throws -> LocalAppClientPreparationResult {
        try await prepareAppClientChannel(model: model, renewing: true)
    }
    private func prepareAppClientChannel(model: DexterAppModel, renewing: Bool) async throws -> LocalAppClientPreparationResult {
        guard !appClientPreparationBusy, applyPhase != .applying, !conversationActive(model),
              !assistantSetupControllers.values.contains(where: { $0.isWorking || $0.hasOwnedLogin }),
              !macSetupControllers.values.contains(where: { $0.isWorking || $0.isUnconfirmed || $0.phase == .awaitingApproval }) else {
            throw LocalAppClientPreparationFailure.busy
        }
        guard !terminating, !Task.isCancelled, initialAttemptFinished, let packaged,
              let previous = supervisor, previous.isRunning, previous.ownsLiveChild,
              let hostID = previous.confirmedHostID, let ownerID = previous.confirmedOwnerID, hostID == model.browserUseHostID,
              LocalHostStartupGate.permits(model, configuration: packaged), model.isOnline, let unlockStore else {
            throw LocalAppClientPreparationFailure.unavailable
        }
        appClientPreparationBusy = true; defer { appClientPreparationBusy = false }
        let addresses = appClientAddresses()
        let stored = appClientPreferences.load(host: packaged.dataDir)
        let address: String, identityGeneration: String?, creationID: String?
        if renewing {
            guard addresses.count == 1, let found = addresses.first, LocalAppClientChannelConfiguration.isPrivateAddress(found) else { throw LocalAppClientPreparationFailure.networkUnavailable }
            address = found; identityGeneration = UUID().uuidString.lowercased(); creationID = UUID().uuidString.lowercased()
        } else {
            switch stored {
            case .missing:
                guard addresses.count == 1, let found = addresses.first, LocalAppClientChannelConfiguration.isPrivateAddress(found) else { throw LocalAppClientPreparationFailure.networkUnavailable }
                address = found; identityGeneration = UUID().uuidString.lowercased(); creationID = UUID().uuidString.lowercased()
            case .saved(let saved, let savedHost, let savedOwner, let savedGeneration):
                guard savedHost == hostID, savedOwner == ownerID else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                guard addresses.contains(saved) else { throw LocalAppClientPreparationFailure.networkUnavailable }
                address = saved; identityGeneration = savedGeneration; creationID = nil
            case .pending(let saved, let savedHost, let savedOwner, let pendingGeneration, let pendingCreation):
                guard savedHost == hostID, savedOwner == ownerID else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                guard addresses.contains(saved) else { throw LocalAppClientPreparationFailure.networkUnavailable }
                address = saved; identityGeneration = pendingGeneration; creationID = pendingCreation
            case .unreadable, .inactive: throw LocalAppClientPreparationFailure.custodyUnavailable
            }
        }
        let planned = try appClientPreferences.configuration(address: address, host: packaged.dataDir,
            installationID: hostID, ownerID: ownerID, generation: identityGeneration, prepare: true)
        let scope = try LocalHostUnlockScope(bundleID: unlockBundleID, custodyFilePath: planned.custodyFile)
        // Reject a known locked/mismatched/pending association BEFORE stopping healthy local chat.
        // New key creation still waits for confirmed exit; a partial creation only resumes its original ID.
        let existingPassword: LocalHostUnlockPassword?
        let pendingAction: LocalDeviceCustodyAction?
        if let creationID, let identityGeneration {
            let expectedPending = LocalAppClientChannelPreferences.Stored.pending(address: address, installationID: hostID,
                ownerID: ownerID, generation: identityGeneration, creationID: creationID)
            if stored == expectedPending {
                switch unlockStore.status(scope: scope) {
                case .missing:
                    guard try scope.fileState() == .absent else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                    existingPassword = nil; pendingAction = nil
                case .configured:
                    guard try unlockStore.creationInfo(scope: scope)?.creationId == creationID else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                    existingPassword = try LocalHostUnlockPassword(ownedBytes: unlockStore.load(scope: scope)); pendingAction = .unlock
                case .blocked:
                    guard try scope.fileState() == .absent, try unlockStore.creationInfo(scope: scope)?.creationId == creationID else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                    existingPassword = try LocalHostUnlockPassword(ownedBytes: unlockStore.loadPendingCreation(scope: scope, expectedCreationId: creationID)); pendingAction = .create
                case .legacyPasswordRequired: throw LocalAppClientPreparationFailure.custodyUnavailable
                }
            } else {
                guard try scope.fileState() == .absent, unlockStore.status(scope: scope) == .missing else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                existingPassword = nil; pendingAction = nil
            }
        } else {
            existingPassword = try appClientPassword(previous.configuration.withAppClientChannel(planned)); pendingAction = nil
        }
        defer { existingPassword?.clear() }
        let deviceUnlock: LocalHostUnlockPassword?
        if previous.configuration.localDeviceCustody != nil, case .saved(let preference) = enginePreferences.load() {
            deviceUnlock = authorizedDeviceUnlock(preference)
            guard deviceUnlock != nil else { throw LocalAppClientPreparationFailure.custodyUnavailable }
        } else { deviceUnlock = nil }
        defer { deviceUnlock?.clear() }
        let generation = model.filesScope
        func selectedInterfaceIsCurrent() -> Bool {
            let current = appClientAddresses()
            return creationID != nil ? current.count == 1 && current.first == address : current.contains(address)
        }
        func currentBeforeStop() -> Bool { !terminating && !Task.isCancelled && supervisor === previous
            && previous.confirmedHostID == hostID && previous.confirmedOwnerID == ownerID && model.filesScope == generation
            && LocalHostStartupGate.permits(model, configuration: packaged) && !conversationActive(model)
            && selectedInterfaceIsCurrent() && appClientPreferences.load(host: packaged.dataDir) == stored }
        guard currentBeforeStop() else { throw LocalAppClientPreparationFailure.busy }
        let stopped = await previous.stop(grace: applyStopGrace)
        guard stopped == .stopped, !previous.ownsLiveChild else { throw LocalAppClientPreparationFailure.outcomeUnknown }
        guard !terminating, !Task.isCancelled, supervisor === previous, model.filesScope == generation,
              model.browserUseHostID == hostID, LocalHostStartupGate.permits(model, configuration: packaged),
              !conversationActive(model), selectedInterfaceIsCurrent(), appClientPreferences.load(host: packaged.dataDir) == stored else {
            throw LocalAppClientPreparationFailure.outcomeUnknown
        }
        let selected: LocalAppClientChannelConfiguration
        let appUnlock: LocalHostUnlockPassword
        var expectedAfterStart = stored
        do {
            if let creationID {
                guard let identityGeneration else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                // The durable intent is written AFTER own exit, BEFORE key creation/handoff. An interruption
                // can resume ONLY this generation and the same Keychain creationId in the human flow.
                let pending = LocalAppClientChannelPreferences.Stored.pending(address: address, installationID: hostID,
                    ownerID: ownerID, generation: identityGeneration, creationID: creationID)
                let resumingPending = stored == pending
                if !resumingPending {
                    try appClientPreferences.savePending(planned, creationID: creationID, host: packaged.dataDir, expected: stored)
                }
                expectedAfterStart = appClientPreferences.load(host: packaged.dataDir)
                let action: LocalDeviceCustodyAction
                if let existingPassword, let pendingAction {
                    guard resumingPending, try unlockStore.creationInfo(scope: scope)?.creationId == creationID,
                          (pendingAction == .create ? (try scope.fileState() == .absent) : unlockStore.status(scope: scope) == .configured) else {
                        throw LocalAppClientPreparationFailure.custodyUnavailable
                    }
                    appUnlock = existingPassword; action = pendingAction
                } else {
                    guard try scope.fileState() == .absent, unlockStore.status(scope: scope) == .missing else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                    let bytes = try unlockStore.create(scope: scope, creationId: creationID)
                    appUnlock = try LocalHostUnlockPassword(ownedBytes: bytes); action = .create
                }
                guard let config = LocalAppClientChannelConfiguration(address: address, custodyFile: planned.custodyFile,
                    installationID: hostID, ownerID: ownerID, generation: identityGeneration, action: action) else { throw LocalAppClientPreparationFailure.custodyUnavailable }
                selected = config
            } else { guard let existingPassword else { throw LocalAppClientPreparationFailure.custodyUnavailable }; selected = planned; appUnlock = existingPassword }
        } catch {
            if await restoreLocalChatAfterAppClientFailure(previous, model: model, generation: generation,
                expectedHostID: hostID, expectedOwnerID: ownerID, afterConfirmedPreparationStop: true) { return .localChatOnly }
            throw LocalAppClientPreparationFailure.custodyUnavailable
        }
        defer { appUnlock.clear() }
        let next = previous.configuration.requiringCustodyAction(.unlock).withAppClientChannel(selected)
        guard !terminating, !Task.isCancelled, supervisor === previous, model.filesScope == generation,
              LocalHostStartupGate.permits(model, configuration: next), selectedInterfaceIsCurrent(),
              appClientPreferences.load(host: packaged.dataDir) == expectedAfterStart else { throw LocalAppClientPreparationFailure.outcomeUnknown }
        let started = makeSupervisor(next)
        started.onUnexpectedExit = { [weak model] failure in
            guard let model, LocalHostStartupGate.permits(model, configuration: next) else { return }
            model.errorMessage = failure.message
        }
        supervisor = started
        let result = await started.start(unlockPassword: deviceUnlock, appClientUnlockPassword: appUnlock)
        guard !Task.isCancelled, !terminating, model.filesScope == generation, LocalHostStartupGate.permits(model, configuration: next),
              appClientPreferences.load(host: packaged.dataDir) == expectedAfterStart else {
            if started.ownsLiveChild, started.state != .stopUncertain { await started.stop(grace: applyStopGrace) }
            throw LocalAppClientPreparationFailure.outcomeUnknown
        }
        guard case .running = result, started.confirmedHostID == hostID, started.confirmedOwnerID == ownerID else {
            if started.ownsLiveChild, started.state != .stopUncertain { await started.stop(grace: applyStopGrace) }
            else if case .failed = result,
                    await restoreLocalChatAfterAppClientFailure(started, model: model, generation: generation, expectedHostID: hostID, expectedOwnerID: ownerID) { return .localChatOnly }
            throw LocalAppClientPreparationFailure.outcomeUnknown
        }
        do { try appClientPreferences.save(selected, host: packaged.dataDir, expected: expectedAfterStart) }
        catch {
            if started.ownsLiveChild { await started.stop(grace: applyStopGrace) }
            throw LocalAppClientPreparationFailure.outcomeUnknown
        }
        appClientChannelNotice = nil
        await model.refresh()
        return .listening
    }
    /// HUMAN SETUP ONLY: exact current choice, own packaged base, no conversation in progress. Creates a
    /// scoped random unlock once, or explicitly resumes the same creation. No legacy reset/rekey/fallback.
    public func prepareDeviceChannel(model: DexterAppModel, resumeCreationID: String? = nil,
        isCurrent: @escaping @MainActor () -> Bool = { true }) async throws {
        guard !Task.isCancelled, isCurrent(), currentEngineConfiguration != nil,
              localRuntimeSetupRefusal(model: model) == nil, let preference = deviceSetupPreference(),
              let scope = unlockScope(preference), let unlockStore else { throw LocalHostUnlockFailure.unavailable }
        let expected = enginePreferences.load(), generation = model.filesScope
        let bytes: OwnedLocalHostUnlockBytes
        let action: LocalDeviceCustodyAction
        switch unlockStore.status(scope: scope) {
        case .configured: action = .unlock; bytes = try unlockStore.load(scope: scope)
        case .missing:
            guard resumeCreationID == nil else { throw LocalHostUnlockFailure.conflict }
            action = .create; bytes = try unlockStore.create(scope: scope)
        case .legacyPasswordRequired: throw LocalHostUnlockFailure.legacyPasswordRequired
        case .blocked:
            guard let resumeCreationID else { throw LocalHostUnlockFailure.conflict }
            action = .create; bytes = try unlockStore.loadPendingCreation(scope: scope, expectedCreationId: resumeCreationID)
        }
        let password = try LocalHostUnlockPassword(ownedBytes: bytes)
        let phase = await applyLocalEnginePreference(preference, model: model, unlockPassword: password,
            expectedPreference: expected, verifyRuntime: { !Task.isCancelled && isCurrent() && model.filesScope == generation }, custodyAction: action)
        guard phase == .applied, currentEngineConfiguration?.localDeviceCustody == preference.localDeviceCustody else {
            if case .refused(let refusal) = phase { throw refusal }
            throw LocalHostUnlockFailure.outcomeUnknown
        }
    }
    public func makeMacAutoSetupController(model: DexterAppModel, agent: LocalMacAgentProcess) -> MacAutoSetupController? {
        guard localRuntimeSetupRefusal(model: model) == nil, currentEngineConfiguration != nil,
              model.isOnline, let hostID = model.browserUseHostID, supervisor?.confirmedHostID == hostID,
              let client = model.makeLocalMcpClient(),
              let location = try? LocalMacAgentSetupLocation.standard(),
              let helper = try? LocalMacAgentHelperPackage.packaged(), let cua = try? LocalMacAgentCuaPackage.packaged(),
              let launch = try? LocalMacAgentLaunchConfiguration.packaged() else { return nil }
        let key = model.filesScope
        if let existing = macSetupControllers[key], existing.isWorking || existing.isUnconfirmed || existing.phase == .awaitingApproval {
            client.close(); return existing
        }
        macSetupControllers = macSetupControllers.filter { $0.value.isWorking || $0.value.isUnconfirmed }
        guard macSetupControllers.count < 32 else { client.close(); return nil }
        let controller = MacAutoSetupController(model: model, host: self, agent: agent, client: client,
            location: location, helper: helper, cua: cua, launch: launch)
        macSetupControllers[key] = controller
        return controller
    }

    private func conversationActive(_ model: DexterAppModel) -> Bool {
        model.localRuntimeSetupBusy
    }

    /// Same eligibility as Apply, exposed to the human setup sheet before it downloads or saves anything.
    public func localRuntimeSetupRefusal(model: DexterAppModel) -> LocalEngineApplyRefusal? {
        guard let packaged else { return .unavailable }
        guard !terminating else { return .quitting }
        guard !appClientPreparationBusy, applyPhase != .applying, initialAttemptFinished, supervisor?.state != .starting, supervisor?.state != .stopping else { return .busy }
        guard LocalHostStartupGate.permits(model, configuration: packaged) else { return .notThisHost }
        return conversationActive(model) ? .conversationActive : nil
    }

    public func makeAssistantSetupController(engine: EngineID, model: DexterAppModel) -> AssistantSetupController? {
        guard [.claude, .codex].contains(engine), acceptsLocalEnginePreference else { return nil }
        let key = model.filesScope + ":" + engine.rawValue
        if let existing = assistantSetupControllers[key], (existing.phase == .unconfirmed || existing.hasOwnedLogin) { return existing }
        guard let runtime = try? AssistantRuntimeSetup.production() else { return nil }
        let controller = AssistantSetupController(engine: engine, model: model, host: self, runtime: runtime)
        assistantSetupControllers = assistantSetupControllers.filter { $0.value.isWorking || $0.value.hasOwnedLogin || $0.value.phase == .unconfirmed }
        guard assistantSetupControllers.count < 32 else { return nil }
        assistantSetupControllers[key] = controller
        return controller
    }

    /// Replaces the window's initial `model.refresh()`. Disarmed: a normal refresh. Armed: the first
    /// window runs the single startup attempt; later windows join it, then refresh normally unless
    /// startup failed (so a connection error does not hide the real failure).
    public func initialRefresh(model: DexterAppModel, macAgent: LocalMacAgentProcess? = nil) async {
        guard let configuration else { await model.refresh(); return }
        if let attempt {
            if await attempt.value { await model.refresh() }
            return
        }
        let task = Task { @MainActor in
            let resolved = self.restoredStartup(configuration, model: model)
            let result = await self.runAttempt(resolved.0, model: model, unlockPassword: resolved.1)
            self.initialAttemptFinished = true
            if result, let macAgent { await self.restorePreparedMacAgent(model: model, agent: macAgent) }
            return result
        }
        attempt = task
        _ = await task.value
    }

    /// Returns whether a normal refresh is appropriate afterwards.
    private func runAttempt(_ configuration: Result<LocalHostLaunchConfiguration, LocalHostFailure>, model: DexterAppModel, unlockPassword: LocalHostUnlockPassword? = nil) async -> Bool {
        defer { unlockPassword?.clear() }
        switch configuration {
        case .failure(let failure):
            // A failed Settings choice concerns only the packaged loopback host: for any other selection
            // behave exactly as the packaged configuration would, and re-check after the awaited refresh.
            if let base = preferenceFailureBase {
                guard LocalHostStartupGate.permits(model, configuration: base) else {
                    await model.refresh()
                    model.errorMessage = LocalHostFailure.connectionNotLocal.message
                    return true
                }
                await model.refresh()
                if LocalHostStartupGate.permits(model, configuration: base) { model.errorMessage = failure.message }
                return true
            }
            await model.refresh()
            model.errorMessage = failure.message
            return true
        case .success(let originalConfig):
            var config = originalConfig.withAppClientChannel(nil)
            var appClientUnlock: LocalHostUnlockPassword?
            var appClientRestoreUnavailable = false
            do {
                let restored = try restoredAppClientConfiguration(originalConfig)
                let password = try appClientPassword(restored)
                config = restored; appClientUnlock = password
            }
            catch {
                // Remote pairing is optional. A locked/missing custody never prevents local chat,
                // creates a replacement key, exposes another interface or impersonates a connection.
                appClientRestoreUnavailable = true
            }
            defer { appClientUnlock?.clear() }
            guard LocalHostStartupGate.permits(model, configuration: config) else {
                await model.refresh()
                model.errorMessage = LocalHostFailure.connectionNotLocal.message
                return true
            }
            if let failure = config.prepareDataParent() {
                model.errorMessage = failure.message
                return false
            }
            if let failure = config.prepareSelectedEngineBindings() {
                model.errorMessage = failure.message; return false
            }
            let supervisor = makeSupervisor(config)
            // A later exit is only reported while the selection is still this loopback host.
            supervisor.onUnexpectedExit = { [weak model] failure in
                guard let model, LocalHostStartupGate.permits(model, configuration: config) else { return }
                model.errorMessage = failure.message
            }
            self.supervisor = supervisor
            let generation = model.filesScope
            let result = await supervisor.start(unlockPassword: unlockPassword, appClientUnlockPassword: appClientUnlock)
            // The selection may have changed during the readiness wait: the result is obsolete. Stop
            // the owned child gracefully (an uncertain stop retains its writer) and refresh the current
            // selection without applying the old startup outcome.
            guard LocalHostStartupGate.permits(model, configuration: config) else {
                if supervisor.ownsLiveChild { await supervisor.stop() }
                await model.refresh()
                return true
            }
            switch result {
            case .running:
                deactivateObsoleteChannelIfNeeded(config: config, hostID: supervisor.confirmedHostID, ownerID: supervisor.confirmedOwnerID)
                await model.refresh()
                if appClientRestoreUnavailable { reportOptionalChannelUnavailable(model) }
                return true
            case .failed(let failure):
                if await restoreLocalChatAfterAppClientFailure(supervisor, model: model, generation: generation) { return true }
                model.errorMessage = failure.message
            case .stopUncertain:
                model.errorMessage = String(localized: "The local host did not stop cleanly; its store and writer lease were left untouched.")
            default: break
            }
            return false
        }
    }

    /// Once per launch, only the previously reviewed auto-start choice. Existing pairing/identity only;
    /// current endpoint metadata is read by GET, no new offer, identity, claim, approval or TCC prompt.
    private func restorePreparedMacAgent(model: DexterAppModel, agent: LocalMacAgentProcess) async {
        guard !automaticMacAttemptFinished else { return }; automaticMacAttemptFinished = true
        guard !terminating, !Task.isCancelled, !agent.ownsLiveChild, let owned = supervisor,
              let current = currentEngineConfiguration,
              current.localDeviceCustody != nil, case .saved(let preference) = enginePreferences.load(),
              preference.localDeviceCustody?.autostartPreparedAgent == true,
              preference.localDeviceCustody?.allowsDeviceTools == true, model.isOnline,
              LocalHostStartupGate.permits(model, configuration: current), let hostID = model.browserUseHostID, supervisor?.confirmedHostID == hostID,
              let client = model.makeLocalMcpClient(), let location = try? LocalMacAgentSetupLocation.standard(),
              case .prepared(var selected) = LocalMacAgentSetup.inspect(location), selected.hasSavedPairing,
              let launch = try? LocalMacAgentLaunchConfiguration.packaged() else { return }
        defer { client.close() }
        let captured = model.filesScope, lifetime = owned.memoryBackendLifetime
        guard let endpoint = owned.localDeviceChannelAddress else { return }
        func valid() -> Bool { !terminating && !Task.isCancelled && supervisor === owned && owned.confirmedHostID == hostID
            && owned.memoryBackendLifetime == lifetime && owned.localDeviceChannelAddress == endpoint && model.isOnline
            && model.filesScope == captured && model.browserUseHostID == hostID
            && enginePreferences.load() == .saved(preference) && !model.localRuntimeSetupBusy
            && LocalHostStartupGate.permits(model, configuration: current) }
        do {
            _ = try LocalMacAgentPolicy.read(selection: selected, expectedInstallationID: hostID)
            guard selected.capabilities.count == 3, Set(selected.capabilities) == Set(["mac.cua.status", "mac.cua.observe", "mac.cua.control"]) else { return }
            if let old = try LocalMacAgentSetup.reconcileEndpointRebind(location: location), old.state != .committed { return }
            await restoreWithCurrentEndpoint()
        } catch { return } // The consumer UI keeps actual offline/unconfirmed state; never repairs or retries.
        func restoreWithCurrentEndpoint() async {
            do {
                guard valid() else { return }
                let metadata = try await client.localMacAgentConnection(); guard valid(), metadata.installationID == hostID,
                    metadata.hostURL == endpoint else { return }
                let snapshot = try LocalMacAgentPolicy.read(selection: selected, expectedInstallationID: hostID)
                if selected.hostURL != metadata.hostURL {
                    selected = try LocalMacAgentSetup.rebindEndpoint(connection: metadata, selection: selected, expectedSnapshot: snapshot,
                        agentStopped: !agent.ownsLiveChild)
                }
                guard valid(), case .usable = await LocalMacAgentSetup.loadIdentity(location: location, selection: selected, expectedInstallationID: hostID),
                    valid(), selected.hasSavedPairing else { return }
                try agent.start(launch, selection: selected)
                guard valid() else { try? await agent.stop(); return }
                await model.refreshDevices()
            } catch { return }
        }
    }
    /// Explicit Stop pauses this auto-start preference without restarting the host or altering any grant.
    public func pausePreparedMacAgent(model: DexterAppModel) -> Bool {
        guard !terminating, let current = currentEngineConfiguration, LocalHostStartupGate.permits(model, configuration: current),
              !model.localRuntimeSetupBusy, case .saved(var preference) = enginePreferences.load(),
              preference.localDeviceCustody != nil else { return false }
        preference.localDeviceCustody?.autostartPreparedAgent = false
        return enginePreferences.save(preference)
    }

    /// After the owner recovered unreadable storage (the launch attempt was refused while it was unreadable), runs
    /// the same single attempt once for the current selection. Nothing starts while a child this app launched is
    /// alive, while another start, Apply or recovery runs, or when quitting; the startup gate is re-checked inside.
    public func startAfterStorageRecovery(model: DexterAppModel) async {
        guard let configuration, initialAttemptFinished, !recoveryAttemptRunning, !terminating, !appClientPreparationBusy,
              applyPhase != .applying, supervisor?.ownsLiveChild != true, !model.requiresStorageReset else {
            await model.refresh(); return
        }
        recoveryAttemptRunning = true
        defer { recoveryAttemptRunning = false }
        _ = await runAttempt(configuration, model: model)
    }
    @ObservationIgnored private var recoveryAttemptRunning = false

    /// Graceful stop of the owned child (joining any stop in flight); returns once it exited or the
    /// grace period elapsed. Never signals a process this app did not launch.
    /// The application declined termination because an owned child has not confirmed exit.
    /// Keep the supervisor/lease; only remove the quit admission gate for later explicit actions.
    public func terminationWasCancelled() { terminating = false }

    public func stopForTermination() async {
        terminating = true
        guard let supervisor, supervisor.ownsLiveChild else { return }
        await supervisor.stop()
    }
}
#endif
