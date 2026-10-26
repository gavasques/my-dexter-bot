#if os(macOS)
import CryptoKit
import Darwin
import Foundation
import Security

/// Guided preparation of the private `local-capabilities` v2 configuration (browser only; CUA stays off
/// until calibration). Preparing writes public trust, a deny-by-default policy and the config; it never
/// starts the daemon, never grants a bot and never touches the Keychain. Identity creation is a separate
/// explicit action through the packaged helper. The pairing code lives only in memory.
public enum LocalMacAgentSetupError: Error, Equatable, Sendable {
    case invalidOffer, offerExpired, invalidInput, helperNotPackaged, alreadyPrepared, conflict
    case unsafeLocation, writeFailed, identityExists, identityUnavailable, signingIdentityUnavailable, identityPolicyUnavailable
}

/// Owner-supplied DEVICE pairing bundle (`PairingBundle` of packages/devices/src/host-server.ts).
/// The code is never written, logged or passed in argv; `description` is redacted.
public struct LocalMacAgentPairingOffer: Sendable, CustomStringConvertible {
    public let hostURL: String
    public let hostFingerprint: String
    public let certificateDER: Data
    public let offerID: String
    public let expiresAt: Date
    let code: String

    public var description: String { "LocalMacAgentPairingOffer(host: \(hostURL), offer: \(offerID), code: <redacted>)" }
    public var pairing: LocalMacAgentPairing { LocalMacAgentPairing(offerID: offerID, code: code) }
    public func isExpired(now: Date = Date()) -> Bool { expiresAt <= now }

    public init(json text: String, now: Date = Date()) throws {
        let data = Data(text.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        guard data.count > 0, data.count <= 32768,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["hostUrl", "hostFingerprint", "hostCertPem", "offerId", "code", "expiresAt"],
              let host = object["hostUrl"] as? String, LocalMacAgentSetup.validHostURL(host),
              let fingerprint = object["hostFingerprint"] as? String, LocalMacAgentSetup.matches(fingerprint, "^[0-9a-f]{64}$"),
              let pem = object["hostCertPem"] as? String, pem.utf8.count <= 16384,
              let offerID = object["offerId"] as? String, LocalMacAgentSetup.matches(offerID, LocalMacAgentSetup.wireID),
              let code = object["code"] as? String, LocalMacAgentSetup.matches(code, "^[A-Za-z0-9_-]{43}$"),
              let number = object["expiresAt"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let milliseconds = Int64(exactly: number.doubleValue), milliseconds > 0 else { throw LocalMacAgentSetupError.invalidOffer }
        guard let der = LocalMacAgentSetup.singleCertificateDER(pem),
              SecCertificateCreateWithData(nil, der as CFData) != nil,
              LocalMacAgentSetup.sha256Hex(der) == fingerprint else { throw LocalMacAgentSetupError.invalidOffer }
        let expiry = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        guard expiry > now else { throw LocalMacAgentSetupError.offerExpired }
        hostURL = host; hostFingerprint = fingerprint; certificateDER = der
        self.offerID = offerID; self.code = code; expiresAt = expiry
    }
}

/// Trusted owner-local setup response. Installation identity is supplied by the canonical host;
/// callers compare it with the host identity already selected in chat. Offers never enter disk/defaults.
public struct LocalMacAgentSetupBundle: Sendable, CustomStringConvertible {
    public let installationID: String
    public let offer: LocalMacAgentPairingOffer
    public var description: String { "LocalMacAgentSetupBundle(installation: \(installationID), code: <redacted>)" }

    public init(json text: String, expectedInstallationID: String, now: Date = Date()) throws {
        let data = Data(text.utf8)
        guard data.count > 0, data.count <= 32768,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["schema", "installationId", "offer"],
              object["schema"] as? String == "dexter.local-mac-agent-setup/1",
              let installation = object["installationId"] as? String,
              LocalMacAgentSetup.matches(installation, LocalMacAgentSetup.wireID),
              installation == expectedInstallationID,
              let offerObject = object["offer"] as? [String: Any],
              let offerData = try? JSONSerialization.data(withJSONObject: offerObject),
              let offerText = String(data: offerData, encoding: .utf8) else { throw LocalMacAgentSetupError.invalidOffer }
        installationID = installation
        offer = try LocalMacAgentPairingOffer(json: offerText, now: now)
    }

    /// No manual installation ID entry: the selected host already authenticated this value.
    public func plan(name: String, browserExecutable: URL, capabilities: [String]) throws -> LocalMacAgentSetupPlan {
        try LocalMacAgentSetupPlan(offer: offer, installationID: installationID, name: name,
                                  browserExecutable: browserExecutable, capabilities: capabilities)
    }
}

/// Helper executable packaged by `scripts/package-local-desktop.mjs --identity-helper`. Older packages have
/// no metadata and therefore no guided setup (the advanced import of a prepared config remains).
public struct LocalMacAgentHelperPackage: Equatable, Sendable {
    public let executable: URL
    public let application: NativeHelperApplication?

    public static func packaged(in bundle: Bundle = .main) throws -> Self {
        let contents = bundle.bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let metadata = contents.appendingPathComponent("Resources/DexterLocalHost/mac-agent-helper.json")
        guard let data = try? Data(contentsOf: metadata), data.count <= 4096,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LocalMacAgentSetupError.helperNotPackaged }
        if object["schema"] as? String == "dexter.mac-agent-helper/2" {
            guard Set(object.keys)==["schema","helper","executable","automaticStart"],object["automaticStart"] as? Bool==false,
                  object["helper"] as? String=="Helpers/DexterDeviceIdentity.app",object["executable"] as? String=="Contents/MacOS/dexter-device-identity" else { throw LocalMacAgentSetupError.helperNotPackaged }
            let app=try NativeHelperApplication(bundle:contents.appendingPathComponent("Helpers/DexterDeviceIdentity.app"),kind:.identity)
            return Self(application:app)
        }
        guard
              Set(object.keys) == ["schema", "helper", "automaticStart"],
              object["schema"] as? String == "dexter.mac-agent-helper/1",
              object["automaticStart"] as? Bool == false,
              let relative = object["helper"] as? String, relative.hasPrefix("Helpers/"),
              !relative.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              !relative.contains("\0") else { throw LocalMacAgentSetupError.helperNotPackaged }
        let url = contents.appendingPathComponent(relative).resolvingSymlinksInPath()
        guard url.path.hasPrefix(contents.resolvingSymlinksInPath().path + "/"),
              FileManager.default.isExecutableFile(atPath: url.path) else { throw LocalMacAgentSetupError.helperNotPackaged }
        return Self(executable: url)
    }

    public init(executable: URL) { self.executable = executable; application=nil }
    public init(application: NativeHelperApplication) { self.application=application;executable=application.executable }
}

/// Canonical private directory owned by the app. Every generated path is inside it.
public struct LocalMacAgentSetupLocation: Equatable, Sendable {
    public let root: URL
    public var configuration: URL { root.appendingPathComponent("config.json") }
    public var helperConfiguration: URL { root.appendingPathComponent("identity-helper.json") }
    public var hostCertificate: URL { root.appendingPathComponent("host-cert.pem") }
    public var policy: URL { root.appendingPathComponent("policy.json") }
    public var dataDirectory: URL { root.appendingPathComponent("data", isDirectory: true) }
    public var helperDirectory: URL { root.appendingPathComponent("helper", isDirectory: true) }
    public var helper: URL { helperDirectory.appendingPathComponent("dexter-device-identity") }
    public var cuaHelper: URL { helperDirectory.appendingPathComponent("dexter-cua-helper") }
    public var helperApplication: URL { helperDirectory.appendingPathComponent("DexterDeviceIdentity.app") }
    public var boundHelper: URL { helperApplication.appendingPathComponent("Contents/MacOS/dexter-device-identity") }
    public var cuaApplication: URL { helperDirectory.appendingPathComponent("DexterControl.app") }
    public var boundCuaHelper: URL { cuaApplication.appendingPathComponent("Contents/MacOS/dexter-cua-helper") }

    public static func standard(fileManager: FileManager = .default) throws -> Self {
        guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw LocalMacAgentSetupError.unsafeLocation
        }
        return Self(root: support.appendingPathComponent("Dexter Mac Agent", isDirectory: true))
    }

    /// Daemon and helper compare realpath; Foundation strips `/private`. Only roots where both agree work.
    public init(root: URL) { self.root = root.standardizedFileURL }
}

/// Validated owner choices, shown in full before any write.
public struct LocalMacAgentSetupPlan: Sendable {
    public static let browserCapabilities = ["mac.browser.navigate", "mac.browser.read", "mac.browser.close"]
    public let offer: LocalMacAgentPairingOffer
    public let installationID: String
    public let name: String
    public let browserExecutable: URL
    public let capabilities: [String]

    public init(offer: LocalMacAgentPairingOffer, installationID: String, name: String,
                browserExecutable: URL, capabilities: [String]) throws {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard LocalMacAgentSetup.matches(installationID, LocalMacAgentSetup.wireID),
              LocalMacAgentSetup.matches(name, "^[\\p{L}\\p{N} ._-]{1,48}$"),
              !capabilities.isEmpty, Set(capabilities).count == capabilities.count,
              capabilities.allSatisfy(Self.browserCapabilities.contains),
              LocalMacAgentSetup.validBrowserExecutable(browserExecutable) else { throw LocalMacAgentSetupError.invalidInput }
        self.offer = offer; self.installationID = installationID; self.name = name
        self.browserExecutable = browserExecutable; self.capabilities = capabilities
    }
}

public enum LocalMacAgentSetupStatus: Sendable {
    case notPrepared
    case prepared(LocalMacAgentSelection)
    /// Something exists in the private directory that the guided flow did not fully produce. Never overwritten.
    case conflict
}

public enum LocalMacAgentSetup {
    static let wireID = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"
    static let productionPolicy = "secure_enclave_data_protection_keychain_device_only"

    /// Read-only. Reopening never resets identity, binding or config.
    public static func inspect(_ location: LocalMacAgentSetupLocation) -> LocalMacAgentSetupStatus {
        let manager = FileManager.default
        guard manager.fileExists(atPath: location.root.path) else { return .notPrepared }
        guard (try? privateDirectory(location.root)) != nil else { return .conflict }
        guard manager.fileExists(atPath: location.configuration.path) else {
            let entries = (try? manager.contentsOfDirectory(atPath: location.root.path)) ?? ["?"]
            return entries.isEmpty ? .notPrepared : .conflict
        }
        guard let selection = try? LocalMacAgentSelection(configurationURL: location.configuration) else { return .conflict }
        return .prepared(selection)
    }

    /// Validated inputs first; then exclusive creation only. Any existing target refuses before writing.
    /// Files created by a failed attempt are removed; nothing pre-existing is touched.
    public static func prepare(_ plan: LocalMacAgentSetupPlan, helper: LocalMacAgentHelperPackage,
                               location: LocalMacAgentSetupLocation, now: Date = Date()) throws -> LocalMacAgentSelection {
        guard !plan.offer.isExpired(now: now) else { throw LocalMacAgentSetupError.offerExpired }
        guard validBrowserExecutable(plan.browserExecutable),
              FileManager.default.isExecutableFile(atPath: helper.executable.path) else { throw LocalMacAgentSetupError.invalidInput }
        let manager = FileManager.default
        let parent = location.root.deletingLastPathComponent()
        guard canonical(parent), realDirectories(parent) else { throw LocalMacAgentSetupError.unsafeLocation }
        if manager.fileExists(atPath: location.root.path) {
            if case .prepared = inspect(location) { throw LocalMacAgentSetupError.alreadyPrepared }
            try privateDirectory(location.root)
            guard (try manager.contentsOfDirectory(atPath: location.root.path)).isEmpty else { throw LocalMacAgentSetupError.conflict }
        }
        let targetHelper=helper.application == nil ? location.helper : location.boundHelper
        let trust = try trustDocuments(plan, location: location, helperExecutable:targetHelper)
        var created: [URL] = []
        do {
            if !manager.fileExists(atPath: location.root.path) {
                try makePrivateDirectory(location.root); created.append(location.root)
            }
            guard canonical(location.root) else { throw LocalMacAgentSetupError.unsafeLocation }
            try makePrivateDirectory(location.helperDirectory); created.append(location.helperDirectory)
            if let app=helper.application {
                guard app.kind == .identity else { throw LocalMacAgentSetupError.helperNotPackaged }
                _=try app.stage(to:location.helperApplication);created.append(location.helperApplication)
            } else {
                try manager.copyItem(at: helper.executable, to: location.helper); created.append(location.helper)
                guard chmod(location.helper.path, 0o700) == 0 else { throw LocalMacAgentSetupError.writeFailed }
            }
            try makePrivateDirectory(location.dataDirectory); created.append(location.dataDirectory)
            for (url, bytes) in [(location.hostCertificate, trust.pem), (location.helperConfiguration, trust.helper),
                                 (location.policy, trust.policy), (location.configuration, trust.config)] {
                try writeExclusive(bytes, to: url); created.append(url)
            }
            return try LocalMacAgentSelection(configurationURL: location.configuration)
        } catch {
            for url in created.reversed() { try? manager.removeItem(at: url) }
            if let failure = error as? LocalMacAgentSetupError { throw failure }
            throw LocalMacAgentSetupError.writeFailed
        }
    }

    /// The pairing must target the prepared destination: same URL string and same host pin.
    public static func pairing(for offer: LocalMacAgentPairingOffer, location: LocalMacAgentSetupLocation,
                               selection: LocalMacAgentSelection, now: Date = Date()) throws -> LocalMacAgentPairing {
        guard !offer.isExpired(now: now) else { throw LocalMacAgentSetupError.offerExpired }
        guard selection.configurationURL == location.configuration, selection.hostURL == offer.hostURL,
              let data = try? Data(contentsOf: location.configuration),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["hostFingerprint"] as? String == offer.hostFingerprint else { throw LocalMacAgentSetupError.conflict }
        return offer.pairing
    }

    /// Explicit owner action only. The helper refuses with `conflict` when an identity already exists,
    /// so this never regenerates. Returns the public fingerprint. Do not call from tests or previews.
    @MainActor public static func provisionIdentity(_ location: LocalMacAgentSetupLocation,
        isCurrent: @escaping @MainActor @Sendable () -> Bool = { true }) async throws -> String {
        try Task.checkCancellation()
        guard isCurrent(), case .prepared(let selection) = inspect(location) else { throw LocalMacAgentSetupError.invalidInput }
        let bytes = try LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384)
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let client = object["client"] as? [String: Any], let installation = client["installationID"] as? String,
              let path = client["executable"] as? String, [location.helper.path, location.boundHelper.path].contains(path) else {
            throw LocalMacAgentSetupError.invalidInput
        }
        let captured = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installation)
        let result = try await invokeProvisionHelper(URL(fileURLWithPath: path), configuration: location.helperConfiguration,
            isCurrent: isCurrent, beforeDispatch: {
                try Task.checkCancellation()
                guard isCurrent(), try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installation) == captured else {
                    throw LocalMacAgentSetupError.conflict
                }
            })
        try Task.checkCancellation()
        guard isCurrent(), try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installation) == captured else {
            throw LocalMacAgentSetupError.conflict
        }
        return try parseProvisionReply(result.bytes, terminationStatus: result.status)
    }

    // MARK: - Generation

    private struct Documents { let pem: Data; let helper: Data; let policy: Data; let config: Data }

    private static func trustDocuments(_ plan: LocalMacAgentSetupPlan, location: LocalMacAgentSetupLocation, helperExecutable:URL) throws -> Documents {
        let der = plan.offer.certificateDER.base64EncodedString()
        var pem = "-----BEGIN CERTIFICATE-----\n"
        var rest = Substring(der)
        while !rest.isEmpty { pem += String(rest.prefix(64)) + "\n"; rest = rest.dropFirst(64) }
        pem += "-----END CERTIFICATE-----\n"
        let helper: [String: Any] = ["installationID": plan.installationID, "hostURL": plan.offer.hostURL,
                                     "hostCertificateDER": der, "hostFingerprint": plan.offer.hostFingerprint]
        let config: [String: Any] = [
            "version": 2, "mode": "local-capabilities", "name": plan.name,
            "dataDir": location.dataDirectory.path, "capabilities": plan.capabilities,
            "hostUrl": plan.offer.hostURL, "hostCertPath": location.hostCertificate.path,
            "hostFingerprint": plan.offer.hostFingerprint,
            "client": ["kind": "native-helper", "executable": helperExecutable.path,
                       "configPath": location.helperConfiguration.path, "installationID": plan.installationID,
                       "identityMode": "production"],
            "policyPath": location.policy.path,
            "browser": ["executable": plan.browserExecutable.path, "networkIsolation": "none"],
            "cua": NSNull(),
        ]
        let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        let documents = Documents(pem: Data(pem.utf8),
                                  helper: try JSONSerialization.data(withJSONObject: helper, options: options),
                                  policy: Data(#"{"bots":[],"version":1}"#.utf8),
                                  config: try JSONSerialization.data(withJSONObject: config, options: options))
        guard documents.config.count <= 16384, documents.helper.count <= 32768 else { throw LocalMacAgentSetupError.invalidInput }
        return documents
    }

    // MARK: - Helper invocation (explicit action only)

    /// MainActor launch keeps the live UI gate and exact policy snapshot next to each dispatch.
    /// A detached drain owns only this one-shot child. Cancellation never promises to undo a provision.
    @MainActor static func invokeProvisionHelper(_ helper: URL, configuration: URL,
        limits: LocalMacAgentProvisionLimits = .production,
        isCurrent: @escaping @MainActor @Sendable () -> Bool,
        beforeDispatch: @MainActor @Sendable () throws -> Void) async throws -> LocalMacAgentProvisionReply {
        try Task.checkCancellation()
        guard isCurrent(), limits.valid else { throw LocalMacAgentSetupError.conflict }
        let owned = LocalMacAgentProvisionProcess(helper: helper, configuration: configuration)
        try beforeDispatch(); try Task.checkCancellation()
        guard isCurrent() else { throw LocalMacAgentSetupError.conflict }
        try owned.launch() // No await between exact snapshot/live gate and this owned Process.run.
        var dispatchFailure: (any Error)?
        do {
            try Task.checkCancellation(); try beforeDispatch()
            guard isCurrent() else { throw LocalMacAgentSetupError.conflict }
            try owned.dispatch() // Only literal {"operation":"provision"}; no caller payload/argv secret.
        } catch is CancellationError { dispatchFailure = CancellationError() }
        catch let error as LocalMacAgentSetupError { dispatchFailure = error }
        catch { dispatchFailure = LocalMacAgentSetupError.identityUnavailable }
        let failure = dispatchFailure
        let drain = Task.detached(priority: .userInitiated) {
            try await owned.drain(limits: limits, isCurrent: isCurrent, initialFailure: failure)
        }
        return try await withTaskCancellationHandler { try await drain.value } onCancel: { drain.cancel() }
    }
    static func parseProvisionReply(_ bytes: Data, terminationStatus: Int32) throws -> String {
        let reply: LocalMacAgentIdentityLoadResult
        do { reply = try parseIdentityLoadReply(bytes) } catch { throw LocalMacAgentSetupError.identityUnavailable }
        switch reply {
        case .usable(let fingerprint):
            guard terminationStatus == 0 else { throw LocalMacAgentSetupError.identityUnavailable }; return fingerprint
        case .missing: throw LocalMacAgentSetupError.identityUnavailable
        case .blocked(let reason):
            switch reason {
            case .conflict: throw LocalMacAgentSetupError.identityExists
            case .signingIdentityUnavailable: throw LocalMacAgentSetupError.signingIdentityUnavailable
            case .nonExportabilityUnconfirmed: throw LocalMacAgentSetupError.identityPolicyUnavailable
            default: throw LocalMacAgentSetupError.identityUnavailable
            }
        }
    }

    // MARK: - Validation and private filesystem

    static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    static func sha256Hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    /// Mirrors daemon-config: https, host, no credentials/query/fragment/path beyond "/".
    static func validHostURL(_ host: String) -> Bool {
        guard host.utf8.count <= 2048, !host.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let url = URL(string: host), url.scheme == "https", let name = url.host, !name.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return false }
        return url.port.map { (1...65535).contains($0) } ?? true
    }

    static func singleCertificateDER(_ pem: String) -> Data? {
        let lines = pem.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard lines.count >= 3, lines.first == "-----BEGIN CERTIFICATE-----", lines.last == "-----END CERTIFICATE-----" else { return nil }
        let body = lines.dropFirst().dropLast()
        guard body.allSatisfy({ matches($0, "^[A-Za-z0-9+/=]+$") }) else { return nil }
        return Data(base64Encoded: body.joined())
    }

    /// Mirrors daemon-config `executable()`: real path, regular, executable, not group/world-writable,
    /// owned by the user or root. An .app is resolved to its main executable by the caller.
    static func validBrowserExecutable(_ url: URL) -> Bool {
        let path = url.path
        guard url.isFileURL, path.hasPrefix("/"), path.utf8.count <= 2048, canonical(url),
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              realDirectories(url.deletingLastPathComponent()) else { return false }
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o111 != 0,
              info.st_mode & 0o022 == 0, info.st_uid == getuid() || info.st_uid == 0 else { return false }
        return true
    }

    /// realpath(3) and Foundation both agree (excludes `/private`-aliased temp roots).
    static func canonical(_ url: URL) -> Bool {
        guard let resolved = realpath(url.path, nil) else { return false }
        defer { free(resolved) }
        return String(cString: resolved) == url.path && url.resolvingSymlinksInPath().path == url.path
    }

    static func realDirectories(_ url: URL) -> Bool {
        var at = url.path
        while at != "/" && !at.isEmpty {
            var info = stat()
            guard lstat(at, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { return false }
            at = (at as NSString).deletingLastPathComponent
        }
        return true
    }

    @discardableResult
    static func privateDirectory(_ url: URL) throws -> URL {
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
              info.st_mode & 0o077 == 0 else { throw LocalMacAgentSetupError.unsafeLocation }
        return url
    }

    private static func makePrivateDirectory(_ url: URL) throws {
        guard mkdir(url.path, 0o700) == 0 else {
            throw errno == EEXIST ? LocalMacAgentSetupError.conflict : LocalMacAgentSetupError.writeFailed
        }
        guard chmod(url.path, 0o700) == 0 else { throw LocalMacAgentSetupError.writeFailed }
        try privateDirectory(url)
    }

    private static func writeExclusive(_ data: Data, to url: URL) throws {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw errno == EEXIST ? LocalMacAgentSetupError.conflict : LocalMacAgentSetupError.writeFailed }
        defer { close(fd) }
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
        guard written == data.count, fchmod(fd, 0o600) == 0, fsync(fd) == 0 else { throw LocalMacAgentSetupError.writeFailed }
    }
}
/// Bounded synthetic-test seam. Production cannot exceed 64KiB/60s or 2s graceful stop.
struct LocalMacAgentProvisionLimits: Sendable {
    let timeout: TimeInterval
    let stopGrace: TimeInterval
    let outputMaximum: Int
    static let production = Self(timeout: 60, stopGrace: 1, outputMaximum: 65536)
    var valid: Bool { timeout > 0 && timeout <= 60 && stopGrace > 0 && stopGrace <= 2 && (1...65536).contains(outputMaximum) }
}
struct LocalMacAgentProvisionReply: Sendable { let bytes: Data; let status: Int32 }
enum LocalMacAgentProvisionInvocationFailure: Error, Equatable { case outputLimit, timedOut, stopUnconfirmed }
/// Process ownership moves from synchronous MainActor launch/dispatch to exactly one detached drain.
/// The cancellation handler only cancels that drain; it never touches another Process, daemon or lease.
private final class LocalMacAgentProvisionProcess: @unchecked Sendable {
    private let process = Process(), input = Pipe(), output = Pipe()
    init(helper: URL, configuration: URL) {
        process.executableURL = helper; process.arguments = ["--config", configuration.path]
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
    }
    func launch() throws {
        guard fcntl(output.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) == 0,
              fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            throw LocalMacAgentSetupError.identityUnavailable
        }
        do { try process.run() } catch { throw LocalMacAgentSetupError.identityUnavailable }
    }
    func dispatch() throws {
        try input.fileHandleForWriting.write(contentsOf: Data(#"{"operation":"provision"}"#.utf8))
        try input.fileHandleForWriting.close()
    }
    func drain(limits: LocalMacAgentProvisionLimits, isCurrent: @MainActor @Sendable () -> Bool,
               initialFailure: (any Error)?) async throws -> LocalMacAgentProvisionReply {
        defer { try? input.fileHandleForWriting.close(); try? output.fileHandleForReading.close() }
        var failure = initialFailure, bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        let deadline = ProcessInfo.processInfo.systemUptime + limits.timeout
        while failure == nil {
            if Task.isCancelled { failure = CancellationError(); break }
            guard await isCurrent() else { failure = LocalMacAgentSetupError.conflict; break }
            if ProcessInfo.processInfo.systemUptime >= deadline { failure = LocalMacAgentProvisionInvocationFailure.timedOut; break }
            let count = read(output.fileHandleForReading.fileDescriptor, &buffer, buffer.count)
            if count > 0 {
                guard bytes.count + count <= limits.outputMaximum else { failure = LocalMacAgentProvisionInvocationFailure.outputLimit; break }
                bytes.append(contentsOf: buffer.prefix(count))
            } else if count == 0 {
                if !process.isRunning { break }
            } else if errno != EAGAIN && errno != EINTR { failure = LocalMacAgentSetupError.identityUnavailable; break }
            do { try await Task.sleep(for: .milliseconds(10)) } catch { failure = CancellationError() }
        }
        if failure != nil { try stopOwnedChild(grace: limits.stopGrace) }
        guard !process.isRunning else { throw LocalMacAgentProvisionInvocationFailure.stopUnconfirmed }
        process.waitUntilExit() // Only after this exact owned child is known exited; no unbounded live wait.
        if let failure { throw failure }
        if Task.isCancelled { throw CancellationError() }
        guard await isCurrent() else { throw LocalMacAgentSetupError.conflict }
        // Writing into a pipe may succeed just before the child exits. An exited helper without
        // any reply is a failed invocation, never a successful dispatch/provision receipt.
        // Typed nonzero JSON replies still reach the strict parser (missing/locked/policy/etc.).
        guard !bytes.isEmpty else { throw LocalMacAgentSetupError.identityUnavailable }
        return .init(bytes: bytes, status: process.terminationStatus)
    }
    private func stopOwnedChild(grace: TimeInterval) throws {
        guard process.isRunning else { return }
        process.terminate()
        let gracefulDeadline = ProcessInfo.processInfo.systemUptime + grace
        while process.isRunning && ProcessInfo.processInfo.systemUptime < gracefulDeadline { usleep(10000) }
        if process.isRunning {
            // Only this one-shot helper PID, never the daemon/host or its lease. No rollback promise.
            guard kill(process.processIdentifier, SIGKILL) == 0 || errno == ESRCH else { throw LocalMacAgentProvisionInvocationFailure.stopUnconfirmed }
            let forceDeadline = ProcessInfo.processInfo.systemUptime + 1
            while process.isRunning && ProcessInfo.processInfo.systemUptime < forceDeadline { usleep(10000) }
        }
        guard !process.isRunning else { throw LocalMacAgentProvisionInvocationFailure.stopUnconfirmed }
    }
}
#endif
