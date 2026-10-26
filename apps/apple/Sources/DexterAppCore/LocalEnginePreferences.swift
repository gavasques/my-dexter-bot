#if os(macOS)
import Darwin
import Foundation

/// The user-owned official CLIs the packaged local host may run. Their binaries and login state are
/// never bundled, copied, executed or read by the app; only absolute launcher paths are handled here.
public enum LocalEngineKind: String, CaseIterable, Codable, Sendable, Identifiable {
    case claude, codex, grok, muse, antigravity
    public var displayName: String { switch self { case .claude: "Claude"; case .codex: "Codex"; case .grok: "Grok"; case .muse: "Muse"; case .antigravity: "Antigravity" } }
    public var launcherNames: [String] { self == .antigravity ? ["agy_acp_server.par"] : [rawValue] }
    public var id: String { rawValue }
}

/// Explicit public configuration only. No vault enumeration, sign-in, token or secret value.
public struct LocalMcpOnePasswordPreference: Codable, Equatable, Sendable {
    public var command: String
    public var vault: String
    public var account: String?

    public init(command: String, vault: String, account: String? = nil) {
        self.command = command; self.vault = vault; self.account = account
    }

    public var isWellFormed: Bool {
        Self.isPlausibleCommand(command)
            && !vault.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
            && vault.range(of: "^[A-Za-z0-9_.-](?:[A-Za-z0-9 _.-]{0,126}[A-Za-z0-9_.-])?$", options: .regularExpression) != nil
            && (account.map { !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
                && $0.range(of: "^[A-Za-z0-9][A-Za-z0-9_.@-]{0,254}$", options: .regularExpression) != nil } ?? true)
    }

    private static func isPlausibleCommand(_ path: String) -> Bool {
        guard path.hasPrefix("/"), path.utf8.count <= 1_024,
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        return parts.last == "op" && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    /// Filesystem metadata only; never executes the chosen program or reads authentication data.
    public var validatedCommand: String? {
        guard isWellFormed, let identity = LocalEngineDiscovery.fileIdentity(command),
              access(identity.resolvedPath, X_OK) == 0 else { return nil }
        return identity.resolvedPath
    }
}

/// Portable encrypted custody is outside the canonical host backup directory. Passwords are never stored here.
public struct LocalDeviceCustodyPreference: Codable, Equatable, Sendable {
    public var filePath: String
    public var allowsDeviceTools: Bool
    public var autostartPreparedAgent: Bool
    public init(filePath: String, allowsDeviceTools: Bool = false, autostartPreparedAgent: Bool = false) {
        self.filePath = filePath; self.allowsDeviceTools = allowsDeviceTools; self.autostartPreparedAgent = autostartPreparedAgent
    }
    private enum CodingKeys: String, CodingKey { case filePath, allowsDeviceTools, autostartPreparedAgent }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        filePath = try values.decode(String.self, forKey: .filePath)
        allowsDeviceTools = try values.decode(Bool.self, forKey: .allowsDeviceTools)
        autostartPreparedAgent = try values.decodeIfPresent(Bool.self, forKey: .autostartPreparedAgent) ?? false
    }
    public static var defaultFilePath: String? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Dexter Host Custody", isDirectory: true)
            .appendingPathComponent("local-device.sealed").path
    }
    public var isWellFormed: Bool {
        guard filePath.hasPrefix("/"), filePath.utf8.count <= 1_024,
              !filePath.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        return filePath.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
            .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
}

/// The explicit choice saved from Settings. Non-secret by construction: consent plus absolute launcher
/// paths. Separate from the connection snapshot; applies only to the packaged bundle at the next opening.
public struct LocalEnginePreference: Codable, Equatable, Sendable {
    public static let currentVersion = 1
    static let maxEncodedBytes = 8_192

    public var version: Int
    public var allowsLocalEngines: Bool
    public var allowsDexterTools: Bool
    public var claudePath: String?
    public var codexPath: String?
    public var grokPath: String?
    public var musePath: String?
    public var antigravityPath: String?
    public var mcpOnePassword: LocalMcpOnePasswordPreference?
    public var localDeviceCustody: LocalDeviceCustodyPreference?

    public init(allowsLocalEngines: Bool, claudePath: String? = nil, codexPath: String? = nil, grokPath: String? = nil, musePath: String? = nil, antigravityPath: String? = nil, allowsDexterTools: Bool = false, mcpOnePassword: LocalMcpOnePasswordPreference? = nil, localDeviceCustody: LocalDeviceCustodyPreference? = nil) {
        version = Self.currentVersion
        self.allowsLocalEngines = allowsLocalEngines
        self.allowsDexterTools = allowsDexterTools
        self.claudePath = claudePath
        self.codexPath = codexPath
        self.grokPath = grokPath; self.musePath = musePath; self.antigravityPath = antigravityPath
        self.mcpOnePassword = mcpOnePassword
        self.localDeviceCustody = localDeviceCustody
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version, allowsLocalEngines, allowsDexterTools, claudePath, codexPath, grokPath, musePath, antigravityPath, mcpOnePassword, localDeviceCustody
    }
    private struct StoredKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: StoredKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        guard keys.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unsupported local preference key."))
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        allowsLocalEngines = try values.decode(Bool.self, forKey: .allowsLocalEngines)
        // Existing v1 choices never consented to Dexter tools. Missing means off, without rewriting storage.
        if values.contains(.allowsDexterTools) {
            allowsDexterTools = try values.decode(Bool.self, forKey: .allowsDexterTools)
        } else {
            allowsDexterTools = false
        }
        claudePath = try values.decodeIfPresent(String.self, forKey: .claudePath)
        codexPath = try values.decodeIfPresent(String.self, forKey: .codexPath)
        grokPath = try values.decodeIfPresent(String.self, forKey: .grokPath)
        musePath = try values.decodeIfPresent(String.self, forKey: .musePath)
        antigravityPath = try values.decodeIfPresent(String.self, forKey: .antigravityPath)
        // Older v1 settings never selected a vault: absence keeps credential custody off.
        mcpOnePassword = try values.decodeIfPresent(LocalMcpOnePasswordPreference.self, forKey: .mcpOnePassword)
        localDeviceCustody = try values.decodeIfPresent(LocalDeviceCustodyPreference.self, forKey: .localDeviceCustody)
    }

    public func path(for kind: LocalEngineKind) -> String? {
        switch kind {
        case .claude: claudePath
        case .codex: codexPath
        case .grok: grokPath
        case .muse: musePath
        case .antigravity: antigravityPath
        }
    }

    /// Structural check only; the filesystem is re-checked by `LocalEngineActivationPlan` at launch.
    var isWellFormed: Bool {
        version == Self.currentVersion
            && (mcpOnePassword?.isWellFormed ?? true)
            && (localDeviceCustody?.isWellFormed ?? true)
            && LocalEngineKind.allCases.allSatisfy { kind in path(for: kind).map { LocalEngineDiscovery.isPlausibleLauncherPath($0, kind: kind) } ?? true }
    }
}

public enum LocalEngineStoredPreference: Equatable, Sendable {
    case missing
    case saved(LocalEnginePreference)
    /// Present but not a well-formed preference; treated as "not allowed" (fail closed).
    case unreadable
}

extension LocalEnginePreference {
    /// First-use preset (Root decision ux-primeiro-uso-conexoes-2026-10-12): the one official CLI the owner chose,
    /// plus the Dexter tools path. Tools here only route tools already configured; they grant no account, file,
    /// screen or command access and change no approval mode, grant, deny or always-accepted type.
    public static func firstUse(kind: LocalEngineKind, launcher: String) -> LocalEnginePreference {
        var preference = LocalEnginePreference(allowsLocalEngines: true, allowsDexterTools: true)
        switch kind {
        case .claude: preference.claudePath = launcher
        case .codex: preference.codexPath = launcher
        case .grok: preference.grokPath = launcher
        case .muse: preference.musePath = launcher
        case .antigravity: preference.antigravityPath = launcher
        }
        return preference
    }

    /// The same saved choice with the Dexter tools path on: the explicit offer at the point of use for older choices.
    public func enablingDexterTools() -> LocalEnginePreference {
        var preference = self
        preference.allowsDexterTools = true
        return preference
    }
}

/// What first use may do with the local-engine choice. Only a Mac with nothing saved receives the preset; any saved
/// or unreadable choice, including an explicit "off", is never rewritten here and is changed only in Assistentes.
public enum FirstUseEnginePlan: Equatable, Sendable {
    case applyPreset(LocalEnginePreference)
    /// The saved choice already runs this CLI; nothing is written or restarted.
    case alreadyChosen
    case preserveExisting
    case notFound

    public static func make(stored: LocalEngineStoredPreference, kind: LocalEngineKind, candidates: [LocalEngineCandidate]) -> FirstUseEnginePlan {
        switch stored {
        case .saved(let preference):
            return preference.allowsLocalEngines && preference.path(for: kind) != nil ? .alreadyChosen : .preserveExisting
        case .unreadable:
            return .preserveExisting
        case .missing:
            guard let launcher = candidates.first(where: { $0.kind == kind })?.launcher else { return .notFound }
            return .applyPreset(.firstUse(kind: kind, launcher: launcher))
        }
    }
}

/// App-domain UserDefaults only (never the global domain or any CLI configuration).
@MainActor
public final class LocalEnginePreferenceStore {
    public static let defaultKey = "com.dexter.apple.local-engine-preference.v1"

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String? = nil) {
        self.defaults = defaults
        self.key = key ?? Self.defaultKey
    }

    public func load() -> LocalEngineStoredPreference {
        guard let value = defaults.object(forKey: key) else { return .missing }
        guard let data = value as? Data, data.count <= LocalEnginePreference.maxEncodedBytes,
              let preference = try? JSONDecoder().decode(LocalEnginePreference.self, from: data),
              preference.isWellFormed else { return .unreadable }
        return .saved(preference)
    }

    /// Persists only a well-formed preference; returns false (nothing written) otherwise.
    @discardableResult
    public func save(_ preference: LocalEnginePreference) -> Bool {
        guard preference.isWellFormed, let data = try? JSONEncoder().encode(preference),
              data.count <= LocalEnginePreference.maxEncodedBytes else { return false }
        defaults.set(data, forKey: key)
        return true
    }
}

/// A launcher found (or chosen) on disk. `launcher` is the path the host's PATH lookup will use;
/// `identity` is the resolved file it executes. Nothing about authentication is known or implied.
public struct LocalEngineCandidate: Equatable, Sendable, Identifiable {
    public let kind: LocalEngineKind
    public let launcher: String
    let identity: LocalEngineFileIdentity
    public var id: String { launcher }
}

struct LocalEngineFileIdentity: Equatable, Sendable {
    let resolvedPath: String
    let device: UInt64
    let inode: UInt64
}

/// Bounded filesystem inspection only: lists a few directories and stats entries named exactly
/// `claude`/`codex`. Never executes anything (not even `--version`), never runs a shell, and never
/// opens `.claude`/`.codex` or any file's contents.
public struct LocalEngineDiscovery: Sendable {
    static let maxPathEntries = 64
    static let maxNodeVersions = 16
    static let maxPathBytes = 1_024

    static let systemDirectories = ["/opt/homebrew/bin", "/usr/local/bin"]

    let searchPATH: String?
    let homeDirectory: String
    let systemDirectories: [String]

    public init(environment: [String: String] = ProcessInfo.processInfo.environment,
                homeDirectory: String = NSHomeDirectory()) {
        self.init(environment: environment, homeDirectory: homeDirectory, systemDirectories: Self.systemDirectories)
    }

    init(environment: [String: String], homeDirectory: String, systemDirectories: [String]) {
        searchPATH = environment["PATH"]
        self.homeDirectory = homeDirectory
        self.systemDirectories = systemDirectories
    }

    /// Received PATH, `~/.local/bin`, Homebrew and /usr/local bins, then installed nvm Node bins.
    func searchDirectories(fileManager: FileManager = .default) -> [String] {
        var directories: [String] = []
        let received = (searchPATH ?? "").split(separator: ":").prefix(Self.maxPathEntries).map(String.init)
        directories += received
        directories += [homeDirectory + "/.local/bin", homeDirectory + "/.volta/bin", homeDirectory + "/.npm-global/bin", homeDirectory + "/.grok/bin", homeDirectory + "/.bun/bin"] + systemDirectories
        directories.append(Bundle.main.bundlePath + "/Contents/Helpers/Antigravity")
        let nvmRoot = homeDirectory + "/.nvm/versions/node"
        if let versions = try? fileManager.contentsOfDirectory(atPath: nvmRoot) {
            let bounded = versions.filter { $0.hasPrefix("v") && !$0.contains("/") }
                .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
                .prefix(Self.maxNodeVersions)
            directories += bounded.map { "\(nvmRoot)/\($0)/bin" }
        }
        var seen = Set<String>()
        return directories.compactMap(Self.normalizedDirectory).filter { seen.insert($0).inserted }
    }

    /// Distinct launchers per kind, in search order. Only validated executables are listed.
    public func candidates(for kind: LocalEngineKind, fileManager: FileManager = .default) -> [LocalEngineCandidate] {
        var seen = Set<String>()
        return searchDirectories(fileManager: fileManager).flatMap { directory in
            kind.launcherNames.compactMap { name in try? Self.validateLauncher(directory + "/" + name, kind: kind).get() }
        }.filter { seen.insert($0.identity.resolvedPath).inserted }
    }

    /// The chosen launcher must be an absolute path whose own basename is `claude`/`codex` and that
    /// resolves (symlinks followed) to an executable regular file. The resolved target may have another
    /// name (e.g. an npm `codex.js`); the launcher name is what PATH lookup matches.
    public static func validateLauncher(_ path: String, kind: LocalEngineKind) -> Result<LocalEngineCandidate, LocalEngineActivationIssue> {
        guard isPlausibleLauncherPath(path, kind: kind) else { return .failure(.unsupportedLauncher(kind)) }
        var linkInfo = stat()
        guard lstat(path, &linkInfo) == 0 else { return .failure(.launcherMissing(kind)) }
        let fileType = linkInfo.st_mode & S_IFMT
        guard fileType == S_IFREG || fileType == S_IFLNK else { return .failure(.unsupportedLauncher(kind)) }
        guard let identity = fileIdentity(path), access(identity.resolvedPath, X_OK) == 0 else {
            return .failure(.launcherMissing(kind))
        }
        return .success(LocalEngineCandidate(kind: kind, launcher: path, identity: identity))
    }

    /// Lexical checks only (absolute, no `.`/`..`/empty segments, bounded, expected basename).
    static func isPlausibleLauncherPath(_ path: String, kind: LocalEngineKind) -> Bool {
        // A colon cannot be represented in a PATH entry, so such a launcher folder is unsupported.
        guard path.hasPrefix("/"), !path.contains("\0"), !path.contains(":"), path.utf8.count <= maxPathBytes else { return false }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return false }
        return segments.last.map { kind.launcherNames.contains(String($0)) } == true
    }

    /// realpath(3) plus device/inode of the target; nil unless the target is a regular file.
    static func fileIdentity(_ path: String) -> LocalEngineFileIdentity? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        var info = stat()
        guard stat(resolved, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return nil }
        return LocalEngineFileIdentity(resolvedPath: String(cString: resolved), device: UInt64(info.st_dev), inode: UInt64(info.st_ino))
    }

    /// nil unless absolute, bounded, without `.`/`..` and representable as one PATH entry (no colon).
    static func normalizedDirectory(_ raw: String) -> String? {
        guard raw.hasPrefix("/"), !raw.contains("\0"), !raw.contains(":"), raw.utf8.count <= maxPathBytes else { return nil }
        let segments = raw.split(separator: "/", omittingEmptySubsequences: true)
        guard !segments.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return "/" + segments.joined(separator: "/")
    }
}

/// Fixed, sanitized reasons; paths and file contents are never echoed.
public enum LocalEngineActivationIssue: Error, Equatable, Sendable {
    case noEngineSelected
    case unsupportedLauncher(LocalEngineKind)
    case launcherMissing(LocalEngineKind)
    /// A different executable with this selected name would be found first.
    case lookupCollision(LocalEngineKind)
    case bundledNodeAliasMissing
    /// A folder the controlled PATH needs (the app's Helpers or a launcher folder) cannot be a PATH entry.
    case unsupportedFolder
    case invalidMcpOnePassword
    case invalidDeviceCustody

    /// English catalog key; the app localizes it (Localizable.xcstrings).
    public var message: String {
        switch self {
        case .noEngineSelected: String(localized: "Select at least one local engine executable.")
        case .unsupportedLauncher(.claude): String(localized: "The selected Claude executable is not a supported launcher named claude.")
        case .unsupportedLauncher(.codex): String(localized: "The selected Codex executable is not a supported launcher named codex.")
        case .launcherMissing(.claude): String(localized: "The selected Claude executable was not found or is not executable.")
        case .launcherMissing(.codex): String(localized: "The selected Codex executable was not found or is not executable.")
        case .launcherMissing(.grok): String(localized: "The selected Grok executable was not found or is not executable.")
        case .launcherMissing(.muse): String(localized: "The selected Muse executable was not found or is not executable.")
        case .launcherMissing(.antigravity): String(localized: "The selected Antigravity executable was not found or is not executable.")
        case .lookupCollision(.claude): String(localized: "Another claude executable would be used instead of the selected one. Select it explicitly or choose another folder.")
        case .lookupCollision(.codex): String(localized: "Another codex executable would be used instead of the selected one. Select it explicitly or choose another folder.")
        case .unsupportedLauncher(.grok): String(localized: "The selected Grok executable is not a supported launcher.")
        case .unsupportedLauncher(.muse): String(localized: "The selected Muse executable is not a supported launcher.")
        case .unsupportedLauncher(.antigravity): String(localized: "The selected Antigravity executable is not a supported launcher.")
        case .lookupCollision(.grok): String(localized: "Another Grok executable would be used instead of the selected launcher.")
        case .lookupCollision(.muse): String(localized: "Another Muse executable would be used instead of the selected launcher.")
        case .lookupCollision(.antigravity): String(localized: "Another Antigravity executable would be used instead of the selected launcher.")
        case .bundledNodeAliasMissing: String(localized: "This app package lacks its bundled Node alias; repackage it before allowing local engines.")
        case .unsupportedFolder: String(localized: "A folder needed for local engines has an unsupported path (for example, one containing a colon). Move Dexter or the selected executable, then try again.")
        case .invalidMcpOnePassword: String(localized: "Choose an executable named op and an explicit 1Password vault. Check the optional account identifier.")
        case .invalidDeviceCustody: String(localized: "The encrypted channel needs a valid private file path outside the host data folder.")
        }
    }
}

/// The controlled PATH for the app-owned host child: bundled Helpers first (so `#!/usr/bin/env node`
/// wrappers get the bundled Node through its `node` alias), then the selected launchers' folders,
/// then base system folders. Selected names' lookup is checked against the user's choice; only their
/// resolved commands are registered by the host.
public struct LocalEngineActivationPlan: Equatable, Sendable {
    static let baseDirectories = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

    public let path: String
    public let selected: [LocalEngineKind]
    /// Observed absolute regular-file targets, not PATH names. This fixes engine lookup, but does not
    /// prevent the user replacing a file between validation and spawn.
    public let commands: [LocalEngineKind: String]
    let bindings: LocalEngineLaunchBindings?

    /// `helpersDirectory` is the bundle's `Contents/Helpers`; `bundledNode` is the packaged `dexter-node`.
    public static func make(_ preference: LocalEnginePreference, helpersDirectory: String, bundledNode: String) -> Result<LocalEngineActivationPlan, LocalEngineActivationIssue> {
        make(preference, helpersDirectory: helpersDirectory, bundledNode: bundledNode, baseDirectories: Self.baseDirectories)
    }

    static func makeBound(_ preference: LocalEnginePreference, helpersDirectory: String, bundledNode: String,
                          bindingsRoot: URL) -> Result<LocalEngineActivationPlan, LocalEngineActivationIssue> {
        make(preference, helpersDirectory: helpersDirectory, bundledNode: bundledNode, baseDirectories: Self.baseDirectories, bindingsRoot: bindingsRoot)
    }

    static func make(_ preference: LocalEnginePreference, helpersDirectory: String, bundledNode: String,
                     baseDirectories: [String], bindingsRoot: URL? = nil) -> Result<LocalEngineActivationPlan, LocalEngineActivationIssue> {
        var chosen: [LocalEngineKind: LocalEngineCandidate] = [:]
        for kind in LocalEngineKind.allCases {
            guard let path = preference.path(for: kind) else { continue }
            switch LocalEngineDiscovery.validateLauncher(path, kind: kind) {
            case .success(let candidate): chosen[kind] = candidate
            case .failure(let issue): return .failure(issue)
            }
        }
        guard !chosen.isEmpty else { return .failure(.noEngineSelected) }
        guard let helpers = LocalEngineDiscovery.normalizedDirectory(helpersDirectory) else { return .failure(.unsupportedFolder) }
        guard let alias = LocalEngineDiscovery.fileIdentity(helpers + "/node"),
              let node = LocalEngineDiscovery.fileIdentity(bundledNode), alias == node else {
            return .failure(.bundledNodeAliasMissing)
        }
        if let bindingsRoot {
            guard let bindings = try? LocalEngineLaunchBindings(root: bindingsRoot, chosen: chosen),
                  LocalEngineDiscovery.normalizedDirectory(bindings.directory.path) != nil else { return .failure(.unsupportedFolder) }
            return .success(LocalEngineActivationPlan(path: ([bindings.directory.path, helpers] + baseDirectories).joined(separator: ":"),
                selected: LocalEngineKind.allCases.filter { chosen[$0] != nil }, commands: chosen.mapValues { $0.identity.resolvedPath }, bindings: bindings))
        }
        var directories = [helpers]
        for kind in LocalEngineKind.allCases {
            guard let candidate = chosen[kind] else { continue }
            directories.append((candidate.launcher as NSString).deletingLastPathComponent)
        }
        directories += baseDirectories
        // Every required folder must be a valid PATH entry; none is dropped, so the serialized PATH is
        // exactly the list checked below.
        var normalized: [String] = []
        for directory in directories {
            guard let entry = LocalEngineDiscovery.normalizedDirectory(directory) else { return .failure(.unsupportedFolder) }
            if !normalized.contains(entry) { normalized.append(entry) }
        }
        directories = normalized

        for kind in LocalEngineKind.allCases {
            // Preserve selected-launcher validation for the shared interpreter/subprocess PATH. An
            // unselected engine may coexist in these folders: the host never registers its driver.
            guard let candidate = chosen[kind] else { continue }
            let name = (candidate.launcher as NSString).lastPathComponent
            let first = directories.lazy.map { $0 + "/" + name }.first { path in
                var info = stat()
                return lstat(path, &info) == 0
            }
            guard let first, LocalEngineDiscovery.fileIdentity(first) == candidate.identity,
                  LocalEngineDiscovery.normalizedDirectory((first as NSString).deletingLastPathComponent)
                    == LocalEngineDiscovery.normalizedDirectory((candidate.launcher as NSString).deletingLastPathComponent)
            else { return .failure(.lookupCollision(kind)) }
        }
        return .success(LocalEngineActivationPlan(path: directories.joined(separator: ":"),
                                                  selected: LocalEngineKind.allCases.filter { chosen[$0] != nil },
                                                  commands: chosen.mapValues { $0.identity.resolvedPath }, bindings: nil))
    }
}
#endif
