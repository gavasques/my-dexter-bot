#if os(macOS)
import Foundation
import Observation
import Darwin

/// Bundled daemon is inert until an operator selects a private native configuration and starts it.
/// This launches the existing policy/identity coordinator; it never provisions identity or grants.
public struct LocalMacAgentLaunchConfiguration: Equatable, Sendable {
    public let node: URL
    public let daemon: URL

    public static func packaged(in bundle: Bundle = .main) throws -> Self {
        let contents = bundle.bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let metadata = contents.appendingPathComponent("Resources/DexterLocalHost/mac-agent-launch.json")
        let data = try Data(contentsOf: metadata)
        guard data.count <= 4096,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["schema", "node", "daemon", "automaticStart"],
              object["schema"] as? String == "dexter.mac-agent-launch/1",
              object["automaticStart"] as? Bool == false else { throw LocalMacAgentError.invalidConfiguration }
        func executable(_ key: String) throws -> URL {
            guard let relative = object[key] as? String, !relative.hasPrefix("/"),
                  !relative.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
                  !relative.contains("\0") else { throw LocalMacAgentError.invalidConfiguration }
            let url = contents.appendingPathComponent(relative).resolvingSymlinksInPath()
            guard url.path.hasPrefix(contents.resolvingSymlinksInPath().path + "/"),
                  FileManager.default.fileExists(atPath: url.path) else { throw LocalMacAgentError.invalidConfiguration }
            return url
        }
        return try Self(node: executable("node"), daemon: executable("daemon"))
    }

    public init(node: URL, daemon: URL) { self.node = node; self.daemon = daemon }
}

/// Pairing offer from the selected host. Never persisted or sent in argv/environment.
public struct LocalMacAgentPairing: Sendable {
    public let offerID: String
    public let code: String
    public init(offerID: String, code: String) { self.offerID = offerID; self.code = code }
}

public enum LocalMacAgentError: Error { case invalidConfiguration, alreadyRunning, stopPending }

/// Public operator-selected destination and requested capability names, for the consent UI.
/// Inspection reads only the selected JSON; daemon validation remains authoritative before identity.
public struct LocalMacAgentSelection: Equatable, Sendable {
    public let configurationURL: URL
    public let hostURL: String
    public let capabilities: [String]
    private let snapshot: Data

    public init(configurationURL: URL) throws {
        guard configurationURL.isFileURL, configurationURL.path.hasPrefix("/"),
              configurationURL == configurationURL.resolvingSymlinksInPath() else { throw LocalMacAgentError.invalidConfiguration }
        let attributes = try FileManager.default.attributesOfItem(atPath: configurationURL.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= 16384 else {
            throw LocalMacAgentError.invalidConfiguration
        }
        let file = try FileHandle(forReadingFrom: configurationURL)
        defer { try? file.close() }
        let data = try file.read(upToCount: 16385) ?? Data()
        guard data.count <= 16384,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["version"] as? Int == 2, object["mode"] as? String == "local-capabilities",
              let client = object["client"] as? [String: Any], client["kind"] as? String == "native-helper",
              (client["identityMode"] == nil || client["identityMode"] as? String == "production"),
              let host = object["hostUrl"] as? String, let url = URL(string: host), url.scheme == "https",
              url.host != nil, url.user == nil, url.password == nil,
              host.utf8.count <= 2048, !host.contains(where: { $0.asciiValue.map({ $0 < 32 || $0 == 127 }) == true }),
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.port == nil || (1...65535).contains(url.port!),
              let capabilities = object["capabilities"] as? [String], !capabilities.isEmpty,
              capabilities.count <= 8, Set(capabilities).count == capabilities.count,
              capabilities.allSatisfy({ Self.allowed.contains($0) }) else { throw LocalMacAgentError.invalidConfiguration }
        if let cua = object["cua"] as? [String: Any], cua["mode"] as? String != "native" {
            throw LocalMacAgentError.invalidConfiguration
        }
        // Optional selected-files policy: absent/null leaves mac.file.* unavailable; daemon validates the file.
        if let files = object["files"], !(files is NSNull) {
            guard let files = files as? [String: Any], Set(files.keys) == ["policyPath"],
                  let path = files["policyPath"] as? String, path.hasPrefix("/"), path.utf8.count <= 2048,
                  !path.contains(where: { $0.asciiValue.map({ $0 < 32 || $0 == 127 }) == true }) else {
                throw LocalMacAgentError.invalidConfiguration
            }
        }
        self.configurationURL = configurationURL; self.hostURL = host; self.capabilities = capabilities
        self.snapshot = data
    }

    private static let allowed: Set<String> = ["mac.browser.navigate", "mac.browser.read", "mac.browser.close",
                                              "mac.cua.status", "mac.cua.observe", "mac.cua.control",
                                              "mac.file.read", "mac.file.append"]
    /// A local pairing record permits a reconnect attempt; only the host confirms presence/revocation.
    public var hasSavedPairing: Bool {
        guard let configuration = try? JSONSerialization.jsonObject(with: snapshot) as? [String: Any],
              let path = configuration["dataDir"] as? String, path.hasPrefix("/"), path.utf8.count <= 2048,
              !path.contains("\0") else { return false }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        let binding = directory.appendingPathComponent("binding.json")
        guard directory == directory.resolvingSymlinksInPath(), binding == binding.resolvingSymlinksInPath(),
              let attributes = try? FileManager.default.attributesOfItem(atPath: binding.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let mode = attributes[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0,
              let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= 16384,
              let file = try? FileHandle(forReadingFrom: binding) else { return false }
        defer { try? file.close() }
        guard let data = try? file.read(upToCount: 16385), data.count <= 16384,
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(record.keys) == ["installationId", "ownerId", "deviceId", "hostFingerprint"],
              let pin = record["hostFingerprint"] as? String,
              pin == configuration["hostFingerprint"] as? String else { return false }
        return ["installationId", "ownerId", "deviceId"].allSatisfy {
            guard let value = record[$0] as? String else { return false }
            return value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil
        }
    }

    fileprivate func unchanged() throws -> Bool {
        let file = try FileHandle(forReadingFrom: configurationURL)
        defer { try? file.close() }
        return try file.read(upToCount: 16385) == snapshot
    }
}

@MainActor @Observable
public final class LocalMacAgentProcess {
    public enum State: Equatable, Sendable { case stopped, running, stopping, exited(Int32) }
    public private(set) var state: State = .stopped
    public private(set) var shutdownNotice: String?
    public var ownsLiveChild: Bool { process?.isRunning == true }

    public func reportUnconfirmedShutdown() {
        shutdownNotice = "O encerramento foi adiado porque a parada do agente ainda não foi confirmada. Aguarde ou tente Parar novamente."
    }
    @ObservationIgnored private var process: Process?
    public init() {}

    /// Call only from the explicit start/consent action. `running` means process alive, not paired.
    /// Existing bindings start with nil; a new pairing receives its operator code over stdin only.
    public func start(_ launch: LocalMacAgentLaunchConfiguration, selection: LocalMacAgentSelection,
                      pairing: LocalMacAgentPairing? = nil, prepareCua: Bool = false) throws {
        refresh()
        guard process == nil else { throw LocalMacAgentError.alreadyRunning }
        guard launch.node.isFileURL, launch.daemon.isFileURL, try selection.unchanged(),
              FileManager.default.isExecutableFile(atPath: launch.node.path) else { throw LocalMacAgentError.invalidConfiguration }
        var pairingInput: Data?
        if let pairing {
            let codePattern = "^[A-Za-z0-9_-]{43}$"
            let idPattern = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"
            guard pairing.code.range(of: codePattern, options: .regularExpression) != nil,
                  pairing.offerID.range(of: idPattern, options: .regularExpression) != nil else {
                throw LocalMacAgentError.invalidConfiguration
            }
            pairingInput = try JSONSerialization.data(withJSONObject: ["offerId": pairing.offerID, "code": pairing.code])
            pairingInput!.append(10)
        }
        let child = Process(), input = Pipe()
        child.executableURL = launch.node
        child.arguments = [launch.daemon.path, "--config", selection.configurationURL.path] + (pairing == nil ? [] : ["--pair"]) + (prepareCua ? ["--prepare-cua"] : [])
        // No engine/account environment, NODE_OPTIONS injection, or inherited stdin. No payload logs.
        child.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        child.standardInput = input
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        try child.run()
        process = child; state = .running; shutdownNotice = nil
        do {
            if let pairingInput { try input.fileHandleForWriting.write(contentsOf: pairingInput) }
            try input.fileHandleForWriting.close()
        } catch {
            try? input.fileHandleForWriting.close()
            child.terminate(); state = .stopping
            throw LocalMacAgentError.stopPending
        }
    }

    /// Refresh from app lifecycle/status polling. Never claims online/paired from process existence.
    public func refresh() {
        guard let child = process, !child.isRunning else { return }
        state = .exited(child.terminationStatus); process = nil; shutdownNotice = nil
    }

    /// SIGTERM enters the daemon's existing drain path. No SIGKILL or lease release from the UI.
    /// A timeout retains ownership and stopping state; call again to await the same child.
    public func stop() async throws {
        refresh()
        guard let child = process else { return }
        if state != .stopping { state = .stopping; child.terminate() }
        let deadline = Date().addingTimeInterval(35)
        while child.isRunning && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        guard !child.isRunning else { throw LocalMacAgentError.stopPending }
        refresh()
    }
}
#endif
