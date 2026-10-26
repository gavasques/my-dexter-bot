#if os(macOS)
import CryptoKit
import DexterHostClient
import Foundation
import Observation

/// First-party files only. No process, network, auth file, skill installer or user-data scan.
public struct AssistantBundledPreparation: Equatable, Sendable {
    public let runtime: Bool
    public let configuration: Bool
    public let guides: Bool
    public static let unavailable = Self(runtime: false, configuration: false, guides: false)

    public static func inspect(contents: URL) -> Self {
        let root = contents.resolvingSymlinksInPath()
        let host = root.appendingPathComponent("Resources/DexterLocalHost")
        struct Manifest: Decodable {
            struct Node: Decodable { let path: String; let sha256: String }
            let schema: String; let node: Node; let files: [String: String]
        }
        struct Launch: Decodable { let schema: String; let node: String; let cli: String }
        func regular(_ url: URL, maximum: Int) -> Data? {
            let resolved = url.resolvingSymlinksInPath()
            guard resolved.path.hasPrefix(root.path + "/"),
                  let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
                  attrs[.type] as? FileAttributeType == .typeRegular,
                  let size = attrs[.size] as? NSNumber, size.intValue > 0, size.intValue <= maximum,
                  let data = try? Data(contentsOf: url, options: .mappedIfSafe), data.count == size.intValue else { return nil }
            return data
        }
        func child(_ relative: String, of parent: URL) -> URL? {
            guard !relative.hasPrefix("/"), !relative.contains("\0"), relative.utf8.count <= 1024,
                  relative.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
            return parent.appendingPathComponent(relative)
        }
        func matches(_ relative: String, parent: URL, hash: String?, maximum: Int) -> Bool {
            guard let hash, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let url = child(relative, of: parent), let bytes = regular(url, maximum: maximum) else { return false }
            return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == hash
        }
        guard let bytes = regular(host.appendingPathComponent("manifest.json"), maximum: 2 * 1024 * 1024),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: bytes),
              manifest.schema == "dexter.local-host-manifest/1", manifest.files.count <= 10_000 else { return .unavailable }
        let runtime = matches(manifest.node.path, parent: root, hash: manifest.node.sha256, maximum: 512 * 1024 * 1024)
        let launchData = regular(host.appendingPathComponent("launch.json"), maximum: 16_384)
        let launch = launchData.flatMap { try? JSONDecoder().decode(Launch.self, from: $0) }
        let cli = "app/node_modules/@dexter/cli/dist/index.js"
        let configuration = launch?.schema == "dexter.local-host-launch/1" && launch?.node == manifest.node.path
            && launch?.cli == "Resources/DexterLocalHost/" + cli
            && matches(cli, parent: host, hash: manifest.files[cli], maximum: 32 * 1024 * 1024)
        let guides = ["app-configuration-guide.js", "harness-guide.js"].allSatisfy { name in
            let path = "app/node_modules/@dexter/context/dist/" + name
            return matches(path, parent: host, hash: manifest.files[path], maximum: 32 * 1024 * 1024)
        }
        return Self(runtime: runtime, configuration: configuration, guides: guides)
    }
}

/// Distinguishes the four facts that used to look like one connected switch.
public struct AssistantFirstRunStatus: Equatable, Sendable {
    public let enabled: Bool
    public let installed: Bool?
    public let available: Bool?
    /// The catalog cannot prove account custody. This is deliberately never inferred from availability.
    public var authentication: String { "unknown" }
    public init(enabled: Bool, installed: Bool?, available: Bool?) {
        self.enabled = enabled; self.installed = installed; self.available = available
    }
}

@Observable @MainActor
public final class AssistantFirstRunCoordinator {
    public enum Phase: Equatable { case idle, checking, ready, blocked }
    public private(set) var phase: Phase = .idle
    public private(set) var bundled: AssistantBundledPreparation = .unavailable
    public private(set) var assistant: AssistantSetupController?
    public private(set) var selectedEngine: EngineID?
    @ObservationIgnored private let model: DexterAppModel
    @ObservationIgnored private let host: LocalHostLaunchCoordinator?
    @ObservationIgnored private let checkBundle: @Sendable () async -> AssistantBundledPreparation
    @ObservationIgnored private let prepareHost: @MainActor () async -> Void
    @ObservationIgnored private var operation: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()

    public init(model: DexterAppModel, localHost: LocalHostLaunchCoordinator?, bundle: Bundle = .main) {
        self.model = model; host = localHost
        let contents = bundle.bundleURL.appendingPathComponent("Contents")
        checkBundle = { await Task.detached(priority: .utility) { AssistantBundledPreparation.inspect(contents: contents) }.value }
        // Joins the existing one-shot startup. It prepares only the bundled host's own directories/configuration.
        prepareHost = { if let localHost { await localHost.initialRefresh(model: model) } }
    }
    init(model: DexterAppModel, checkBundle: @escaping @Sendable () async -> AssistantBundledPreparation,
         prepareHost: @escaping @MainActor () async -> Void) {
        self.model = model; host = nil; self.checkBundle = checkBundle; self.prepareHost = prepareHost
    }

    public var ownsThisBase: Bool {
        guard let host, let address = host.launchHostAddress else { return false }
        return host.acceptsLocalEnginePreference && model.isUsingThisMacBase(localAddress: address)
    }
    public var hostIsReady: Bool {
        ownsThisBase && model.isOnline && model.browserUseHostID != nil && host?.confirmedOwnedHostID == model.browserUseHostID
    }
    public var canPrepareAssistant: Bool {
        phase == .ready && hostIsReady && host?.localRuntimeSetupRefusal(model: model) == nil
    }
    public func status(_ engine: EngineID) -> AssistantFirstRunStatus {
        let entry = model.engineCatalog.first { $0.id == engine.rawValue }
        let enabled: Bool
        if case .saved(let preference)? = host?.loadLocalEnginePreference(), let kind = LocalEngineKind(rawValue: engine.rawValue) {
            enabled = preference.allowsLocalEngines && preference.path(for: kind) != nil
        } else { enabled = false }
        return Self.status(enabled: enabled, entry: entry, lookup: model.engineCatalogLookup)
    }
    public static func status(enabled: Bool, entry: EngineCatalogEntry?, lookup: EngineCatalogLookup) -> AssistantFirstRunStatus {
        guard lookup == .loaded, let entry else { return .init(enabled: enabled, installed: nil, available: nil) }
        return .init(enabled: enabled, installed: entry.installed, available: entry.available && entry.adapterSupported != false)
    }

    /// Safe automatic preparation on first display; repeated rendering cannot start another operation.
    public func open() {
        guard phase == .idle else { return }
        phase = .checking; let token = generation
        operation = Task { [weak self] in
            guard let self else { return }
            let snapshot = await checkBundle()
            guard !Task.isCancelled, token == generation else { return }
            bundled = snapshot
            guard snapshot.runtime && snapshot.configuration && snapshot.guides else { phase = .blocked; return }
            await prepareHost()
            guard !Task.isCancelled, token == generation else { return }
            phase = .ready
        }
    }
    public func refresh() {
        guard phase != .checking else { return }
        generation = UUID(); phase = .idle; open()
    }
    /// Only the owner's provider button opens metadata preparation. Download still requires Install and use.
    public func choose(_ engine: EngineID) {
        guard [.claude, .codex].contains(engine), canPrepareAssistant,
              assistant?.isWorking != true, let controller = host?.makeAssistantSetupController(engine: engine, model: model) else { return }
        selectedEngine = engine; assistant = controller
    }
    public func closeAssistant() { assistant?.close(); assistant = nil }
    public func close() {
        generation = UUID(); operation?.cancel(); operation = nil; closeAssistant()
        if phase == .checking { phase = .idle }
    }
}
#endif
