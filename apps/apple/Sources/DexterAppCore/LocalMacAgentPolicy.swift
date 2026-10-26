#if os(macOS)
import CryptoKit
import Darwin
import Foundation
import Security

public enum LocalMacAgentPolicyError: Error, Equatable, Sendable {
    case invalidPolicy, unsafeLocation, hostMismatch, conflict, agentMustBeStopped, writeFailed
}

/// Explicit owner choices only. Browser choices preserve separate CUA scopes and never expand a host grant.
public struct LocalMacAgentBrowserAuthorization: Equatable, Sendable {
    public let botID: String
    public let label: String
    public let operations: [String]
    public let browserOrigins: [String]
    public let cuaMaxSessionSeconds = 0

    public init(botID: String, label: String, operations: [String], browserOrigins: [String]) throws {
        guard LocalMacAgentSetup.matches(botID, LocalMacAgentSetup.wireID),
              LocalMacAgentSetup.matches(label, "^[\\p{L}\\p{N} ._-]{1,48}$"), operations.count <= 3,
              Set(operations).count == operations.count,
              operations.allSatisfy(LocalMacAgentSetupPlan.browserCapabilities.contains), browserOrigins.count <= 32 else {
            throw LocalMacAgentPolicyError.invalidPolicy
        }
        self.botID = botID; self.label = label; self.operations = operations.sorted()
        self.browserOrigins = try Array(Set(browserOrigins.map(LocalMacAgentPolicy.origin))).sorted()
    }
}

public struct LocalMacAgentPolicySnapshot: Equatable, Sendable {
    public let authorizations: [LocalMacAgentBrowserAuthorization]
    public let cuaAuthorizations: [LocalMacAgentCuaAuthorization]
    /// Device ID from the validated public pairing record of this agent, if it was paired. Not presence or a grant.
    public let boundDeviceID: String?
    fileprivate let grants: [LocalMacAgentGrant]
    public let policyURL: URL
    fileprivate let selection: LocalMacAgentSelection
    fileprivate let installationID: String
    fileprivate let bytes: Data
    fileprivate let trustDigest: String
}

public struct LocalMacAgentCuaAuthorization: Equatable, Sendable {
    public static let operations = ["mac.cua.status", "mac.cua.observe", "mac.cua.control"]
    public let botID: String
    public let label: String
    public let operations: [String]
    public let maxSessionSeconds: Int
    public init(botID: String, label: String, operations: [String], maxSessionSeconds: Int) throws {
        guard LocalMacAgentSetup.matches(botID, LocalMacAgentSetup.wireID),
              LocalMacAgentSetup.matches(label, "^[\\p{L}\\p{N} ._-]{1,48}$"), !operations.isEmpty,
              Set(operations).count == operations.count, operations.allSatisfy(Self.operations.contains),
              (1...900).contains(maxSessionSeconds) else { throw LocalMacAgentPolicyError.invalidPolicy }
        self.botID = botID; self.label = label; self.operations = operations.sorted(); self.maxSessionSeconds = maxSessionSeconds
    }
}

fileprivate struct LocalMacAgentGrant: Equatable, Sendable {
    let botID: String
    var label: String
    var operations: [String]
    var origins: [String]
    var cuaSeconds: Int
}

public enum LocalMacAgentPolicy {
    /// Read-only: opening the sheet does not materialize a policy, identity or grant.
    public static func read(selection: LocalMacAgentSelection, expectedInstallationID: String) throws -> LocalMacAgentPolicySnapshot {
        guard LocalMacAgentSetup.matches(expectedInstallationID, LocalMacAgentSetup.wireID),
              try LocalMacAgentSelection(configurationURL: selection.configurationURL) == selection else { throw LocalMacAgentPolicyError.conflict }
        let root = selection.configurationURL.deletingLastPathComponent()
        let location = LocalMacAgentSetupLocation(root: root)
        guard selection.configurationURL == location.configuration, LocalMacAgentSetup.canonical(root), LocalMacAgentSetup.realDirectories(root) else {
            throw LocalMacAgentPolicyError.unsafeLocation
        }
        for directory in [root, location.helperDirectory, location.dataDirectory] { try directoryGuard(directory) }
        let configBytes = try privateRead(location.configuration, maximum: 16384)
        guard let config = try JSONSerialization.jsonObject(with: configBytes) as? [String: Any],
              let client = config["client"] as? [String: Any],
              client["kind"] as? String == "native-helper", client["identityMode"] as? String == "production",
              client["installationID"] as? String == expectedInstallationID,
              let helperPath=client["executable"] as? String,[location.helper.path,location.boundHelper.path].contains(helperPath),client["configPath"] as? String == location.helperConfiguration.path,
              config["policyPath"] as? String == location.policy.path, config["dataDir"] as? String == location.dataDirectory.path,
              config["hostCertPath"] as? String == location.hostCertificate.path,
              let pin = config["hostFingerprint"] as? String, LocalMacAgentSetup.matches(pin, "^[0-9a-f]{64}$") else {
            throw LocalMacAgentPolicyError.hostMismatch
        }
        let fields: Set<String> = ["version", "mode", "name", "dataDir", "capabilities", "hostUrl", "hostCertPath", "hostFingerprint", "client", "policyPath", "browser", "cua"]
        guard Set(config.keys) == fields || Set(config.keys) == fields.union(["files"]),
              Set(client.keys) == ["kind", "executable", "configPath", "installationID", "identityMode"] else { throw LocalMacAgentPolicyError.invalidPolicy }
        if let browser = config["browser"] as? [String: Any] {
            guard Set(browser.keys) == ["executable", "networkIsolation"], browser["networkIsolation"] as? String == "none",
                  let browserPath = browser["executable"] as? String, LocalMacAgentSetup.validBrowserExecutable(URL(fileURLWithPath: browserPath)) else { throw LocalMacAgentPolicyError.invalidPolicy }
        } else {
            guard config["browser"] is NSNull, let capabilities = config["capabilities"] as? [String],
                  Set(LocalMacAgentCuaAuthorization.operations).isSubset(of: Set(capabilities)),
                  capabilities.allSatisfy({ LocalMacAgentCuaAuthorization.operations.contains($0) || $0 == "mac.file.read" || $0 == "mac.file.append" }),
                  config["cua"] is [String: Any] else { throw LocalMacAgentPolicyError.invalidPolicy }
        }
        let helperBytes = try privateRead(location.helperConfiguration, maximum: 32768)
        let certificate = try privateRead(location.hostCertificate, maximum: 16384)
        guard let helper = try JSONSerialization.jsonObject(with: helperBytes) as? [String: Any],
              Set(helper.keys) == ["installationID", "hostURL", "hostCertificateDER", "hostFingerprint"],
              helper["installationID"] as? String == expectedInstallationID,
              helper["hostURL"] as? String == selection.hostURL, helper["hostFingerprint"] as? String == pin,
              let pem = String(data: certificate, encoding: .utf8), let der = LocalMacAgentSetup.singleCertificateDER(pem),
              SecCertificateCreateWithData(nil, der as CFData) != nil,
              helper["hostCertificateDER"] as? String == der.base64EncodedString(), LocalMacAgentSetup.sha256Hex(der) == pin else {
            throw LocalMacAgentPolicyError.hostMismatch
        }
        let executable = try privateRead(URL(fileURLWithPath:helperPath), maximum: 64 * 1024 * 1024, executable: true)
        var trust = configBytes + helperBytes + certificate + Data(SHA256.hash(data: executable))
        if helperPath == location.boundHelper.path {
            trust.append(try NativeHelperApplication(bundle:location.helperApplication,kind:.identity).snapshot().digest)
        }
        if let cua = config["cua"] as? [String: Any] {
            guard Set(cua.keys) == ["mode", "executable"], cua["mode"] as? String == "native",
                  let cuaPath=cua["executable"] as? String,[location.cuaHelper.path,location.boundCuaHelper.path].contains(cuaPath) else { throw LocalMacAgentPolicyError.invalidPolicy }
            trust.append(Data(SHA256.hash(data: try privateRead(URL(fileURLWithPath:cuaPath), maximum: 64 * 1024 * 1024, executable: true))))
            if cuaPath == location.boundCuaHelper.path { trust.append(try NativeHelperApplication(bundle:location.cuaApplication,kind:.cua).snapshot().digest) }
        } else if !(config["cua"] is NSNull) { throw LocalMacAgentPolicyError.invalidPolicy }
        // Only public binding/fingerprint records; no Keychain, key files or helper invocation.
        var boundDeviceID: String?
        for name in ["binding.json", "native-device.json"] {
            let url = location.dataDirectory.appendingPathComponent(name)
            var st = stat()
            if lstat(url.path, &st) == 0 {
                let bytes = try privateRead(url, maximum: 16384)
                guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw LocalMacAgentPolicyError.hostMismatch }
                if name == "binding.json" {
                    guard Set(object.keys) == ["installationId", "ownerId", "deviceId", "hostFingerprint"],
                          object["installationId"] as? String == expectedInstallationID, object["hostFingerprint"] as? String == pin,
                          let ownerID = object["ownerId"] as? String, let deviceID = object["deviceId"] as? String,
                          LocalMacAgentSetup.matches(ownerID, LocalMacAgentSetup.wireID), LocalMacAgentSetup.matches(deviceID, LocalMacAgentSetup.wireID) else {
                        throw LocalMacAgentPolicyError.hostMismatch
                    }
                    boundDeviceID = deviceID
                } else {
                    guard Set(object.keys) == ["fingerprint"], let fingerprint = object["fingerprint"] as? String,
                          LocalMacAgentSetup.matches(fingerprint, "^[0-9a-f]{64}$") else { throw LocalMacAgentPolicyError.hostMismatch }
                }
                trust.append(bytes)
            } else if errno != ENOENT { throw LocalMacAgentPolicyError.unsafeLocation }
        }
        let bytes = try privateRead(location.policy, maximum: 1024 * 1024)
        let bots = try parse(bytes)
        let browsers = try bots.filter { !$0.origins.isEmpty || $0.operations.contains(where: LocalMacAgentSetupPlan.browserCapabilities.contains) }.map {
            try LocalMacAgentBrowserAuthorization(botID: $0.botID, label: $0.label, operations: $0.operations.filter(LocalMacAgentSetupPlan.browserCapabilities.contains), browserOrigins: $0.origins)
        }
        let cua = try bots.filter { $0.operations.contains(where: LocalMacAgentCuaAuthorization.operations.contains) }.map {
            try LocalMacAgentCuaAuthorization(botID: $0.botID, label: $0.label, operations: $0.operations.filter(LocalMacAgentCuaAuthorization.operations.contains), maxSessionSeconds: $0.cuaSeconds)
        }
        return LocalMacAgentPolicySnapshot(authorizations: browsers, cuaAuthorizations: cua, boundDeviceID: boundDeviceID, grants: bots, policyURL: location.policy, selection: selection,
                                           installationID: expectedInstallationID, bytes: bytes, trustDigest: LocalMacAgentSetup.sha256Hex(trust))
    }

    /// Caller must refresh its process owner and confirm stopped/exited AND no live child. Never auto-restarts.
    public static func replaceBot(_ authorization: LocalMacAgentBrowserAuthorization, expectedSnapshot: LocalMacAgentPolicySnapshot,
                                  agentStopped: Bool) throws -> LocalMacAgentPolicySnapshot {
        var bots = expectedSnapshot.grants.filter { $0.botID != authorization.botID }
        let previous = expectedSnapshot.grants.first { $0.botID == authorization.botID }
        bots.append(LocalMacAgentGrant(botID: authorization.botID, label: authorization.label,
                                       operations: (authorization.operations + (previous?.operations.filter(LocalMacAgentCuaAuthorization.operations.contains) ?? [])).sorted(),
                                       origins: authorization.browserOrigins, cuaSeconds: previous?.cuaSeconds ?? 0))
        return try save(bots, expected: expectedSnapshot, agentStopped: agentStopped)
    }
    public static func removeBot(botID: String, expectedSnapshot: LocalMacAgentPolicySnapshot,
                                 agentStopped: Bool) throws -> LocalMacAgentPolicySnapshot {
        guard LocalMacAgentSetup.matches(botID, LocalMacAgentSetup.wireID) else { throw LocalMacAgentPolicyError.invalidPolicy }
        let bots = expectedSnapshot.grants.compactMap { grant -> LocalMacAgentGrant? in
            guard grant.botID == botID else { return grant }
            let cua = grant.operations.filter(LocalMacAgentCuaAuthorization.operations.contains)
            return cua.isEmpty ? nil : LocalMacAgentGrant(botID: grant.botID, label: grant.label, operations: cua, origins: [], cuaSeconds: grant.cuaSeconds)
        }
        return try save(bots, expected: expectedSnapshot, agentStopped: agentStopped)
    }

    public static func replaceCua(_ authorization: LocalMacAgentCuaAuthorization, expectedSnapshot: LocalMacAgentPolicySnapshot,
                                  agentStopped: Bool) throws -> LocalMacAgentPolicySnapshot {
        var bots = expectedSnapshot.grants.filter { $0.botID != authorization.botID }
        let previous = expectedSnapshot.grants.first { $0.botID == authorization.botID }
        bots.append(LocalMacAgentGrant(botID: authorization.botID, label: previous?.label ?? authorization.label,
                                      operations: ((previous?.operations.filter(LocalMacAgentSetupPlan.browserCapabilities.contains) ?? []) + authorization.operations).sorted(),
                                      origins: previous?.origins ?? [], cuaSeconds: authorization.maxSessionSeconds))
        return try save(bots, expected: expectedSnapshot, agentStopped: agentStopped)
    }

    public static func removeCua(botID: String, expectedSnapshot: LocalMacAgentPolicySnapshot, agentStopped: Bool) throws -> LocalMacAgentPolicySnapshot {
        guard LocalMacAgentSetup.matches(botID, LocalMacAgentSetup.wireID) else { throw LocalMacAgentPolicyError.invalidPolicy }
        let bots = expectedSnapshot.grants.compactMap { grant -> LocalMacAgentGrant? in
            guard grant.botID == botID else { return grant }
            let browser = grant.operations.filter(LocalMacAgentSetupPlan.browserCapabilities.contains)
            return browser.isEmpty && grant.origins.isEmpty ? nil : LocalMacAgentGrant(botID: grant.botID, label: grant.label, operations: browser, origins: grant.origins, cuaSeconds: 0)
        }
        return try save(bots, expected: expectedSnapshot, agentStopped: agentStopped)
    }

    static func origin(_ value: String) throws -> String {
        guard value.utf8.count <= 256, !value.contains(where: { $0.isWhitespace || $0.asciiValue.map({ $0 < 32 || $0 == 127 }) == true }),
              let url = URL(string: value), let scheme = url.scheme, ["http", "https"].contains(scheme),
              let host = url.host, !host.isEmpty, !host.contains("*"), !host.contains("%"),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/", url.port.map({ (1...65535).contains($0) }) ?? true else {
            throw LocalMacAgentPolicyError.invalidPolicy
        }
        let port = url.port
        let suffix = port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80) ? "" : ":\(port!)"
        return "\(scheme)://\(host.lowercased())\(suffix)"
    }

    private static func parse(_ bytes: Data) throws -> [LocalMacAgentGrant] {
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(object.keys) == ["version", "bots"],
              let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let raw = object["bots"] as? [[String: Any]], raw.count <= 64 else { throw LocalMacAgentPolicyError.invalidPolicy }
        let bots = try raw.map { bot in
            guard Set(bot.keys) == ["botId", "label", "operations", "browserOrigins", "cuaMaxSessionSeconds"],
                  let botID = bot["botId"] as? String, let label = bot["label"] as? String,
                  let operations = bot["operations"] as? [String], let origins = bot["browserOrigins"] as? [String],
                  let seconds = bot["cuaMaxSessionSeconds"] as? NSNumber, CFGetTypeID(seconds) != CFBooleanGetTypeID(),
                  let duration = Int(exactly: seconds.doubleValue), (0...900).contains(duration),
                  operations.count <= 6, Set(operations).count == operations.count,
                  operations.allSatisfy((LocalMacAgentSetupPlan.browserCapabilities + LocalMacAgentCuaAuthorization.operations).contains) else {
                throw LocalMacAgentPolicyError.invalidPolicy
            }
            let browser = try LocalMacAgentBrowserAuthorization(botID: botID, label: label, operations: operations.filter(LocalMacAgentSetupPlan.browserCapabilities.contains), browserOrigins: origins)
            let cua = operations.filter(LocalMacAgentCuaAuthorization.operations.contains)
            guard cua.isEmpty ? duration == 0 : duration > 0 else { throw LocalMacAgentPolicyError.invalidPolicy }
            return LocalMacAgentGrant(botID: botID, label: label, operations: operations.sorted(), origins: browser.browserOrigins, cuaSeconds: duration)
        }
        guard Set(bots.map(\.botID)).count == bots.count else { throw LocalMacAgentPolicyError.invalidPolicy }
        return bots
    }
    private static func save(_ bots: [LocalMacAgentGrant], expected: LocalMacAgentPolicySnapshot,
                             agentStopped: Bool) throws -> LocalMacAgentPolicySnapshot {
        guard agentStopped else { throw LocalMacAgentPolicyError.agentMustBeStopped }
        guard bots.count <= 64, try read(selection: expected.selection, expectedInstallationID: expected.installationID) == expected else {
            throw LocalMacAgentPolicyError.conflict
        }
        let object: [String: Any] = ["version": 1, "bots": bots.map { ["botId": $0.botID, "label": $0.label, "operations": $0.operations,
                                                                      "browserOrigins": $0.origins, "cuaMaxSessionSeconds": $0.cuaSeconds] }]
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        let root = expected.policyURL.deletingLastPathComponent(), temporary = ".policy-\(UUID().uuidString).tmp"
        let directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directory >= 0 else { throw LocalMacAgentPolicyError.writeFailed }
        defer { close(directory) }
        var opened = stat()
        guard fstat(directory, &opened) == 0, opened.st_uid == getuid(), opened.st_mode & 0o777 == 0o700 else {
            throw LocalMacAgentPolicyError.unsafeLocation
        }
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw LocalMacAgentPolicyError.writeFailed }
        defer { close(fd); unlinkat(directory, temporary, 0) }
        let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
        guard written == bytes.count, fchmod(fd, 0o600) == 0, fsync(fd) == 0,
              try read(selection: expected.selection, expectedInstallationID: expected.installationID) == expected else {
            throw LocalMacAgentPolicyError.writeFailed
        }
        var current = stat()
        guard lstat(root.path, &current) == 0, current.st_dev == opened.st_dev, current.st_ino == opened.st_ino,
              renameat(directory, temporary, directory, expected.policyURL.lastPathComponent) == 0 else {
            throw LocalMacAgentPolicyError.writeFailed
        }
        guard fsync(directory) == 0 else { throw LocalMacAgentPolicyError.writeFailed }
        return try read(selection: expected.selection, expectedInstallationID: expected.installationID)
    }
    private static func directoryGuard(_ url: URL) throws {
        guard LocalMacAgentSetup.canonical(url), LocalMacAgentSetup.realDirectories(url) else { throw LocalMacAgentPolicyError.unsafeLocation }
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & 0o777 == 0o700 else { throw LocalMacAgentPolicyError.unsafeLocation }
        do { try LocalMacAgentSetup.privateDirectory(url) } catch { throw LocalMacAgentPolicyError.unsafeLocation }
    }
    static func privateRead(_ url: URL, maximum: Int, executable: Bool = false) throws -> Data {
        guard LocalMacAgentSetup.canonical(url), LocalMacAgentSetup.realDirectories(url.deletingLastPathComponent()) else { throw LocalMacAgentPolicyError.unsafeLocation }
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw LocalMacAgentPolicyError.unsafeLocation }
        defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_uid == getuid(), before.st_nlink == 1,
              before.st_mode & 0o777 == (executable ? 0o700 : 0o600), before.st_size > 0, before.st_size <= maximum else {
            throw LocalMacAgentPolicyError.unsafeLocation
        }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        let bytes = try file.read(upToCount: maximum + 1) ?? Data()
        var after = stat()
        guard bytes.count == before.st_size, fstat(fd, &after) == 0, before.st_ino == after.st_ino,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw LocalMacAgentPolicyError.conflict }
        return bytes
    }
}
#endif
