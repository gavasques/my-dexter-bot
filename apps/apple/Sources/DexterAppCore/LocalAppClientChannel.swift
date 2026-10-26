#if os(macOS)
import CryptoKit
import Darwin
import Foundation

public enum LocalAppClientPreparationFailure: Error, Equatable, Sendable {
    case unavailable, networkUnavailable, busy, custodyUnavailable, outcomeUnknown
}

public enum LocalAppClientPreparationResult: Equatable, Sendable {
    case listening
    /// A candidate failed and exited; local-only chat was restored. No remote connection is claimed.
    case localChatOnly
}

/// Public launch metadata. The private key stays encrypted on disk; its unlock is a separate owned pipe buffer.
public struct LocalAppClientChannelConfiguration: Equatable, Sendable {
    public let address: String
    public let custodyFile: String
    public let installationID: String
    public let ownerID: String
    public let generation: String?
    public let action: LocalDeviceCustodyAction
    public static let port: UInt16 = 4319
    public var origin: String { "https://\(address):\(Self.port)" }
    public init?(address: String, custodyFile: String, installationID: String, ownerID: String, generation: String? = nil, action: LocalDeviceCustodyAction = .unlock) {
        guard generation.map(Self.isGeneration) ?? true, Self.isIdentity(installationID), Self.isIdentity(ownerID), Self.isPrivateAddress(address), custodyFile.hasPrefix("/"), !custodyFile.contains("\0"),
              custodyFile.utf8.count <= 1024,
              custodyFile.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
        self.address = address; self.custodyFile = custodyFile; self.installationID = installationID; self.ownerID = ownerID; self.generation = generation; self.action = action
    }
    static func isGeneration(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func isIdentity(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil }
    public static func isPrivateAddress(_ address: String) -> Bool {
        let fields = address.split(separator: ".", omittingEmptySubsequences: false)
        guard fields.count == 4 else { return false }
        let parts = fields.compactMap { UInt8($0) }
        return parts.count == 4 && zip(fields, parts).allSatisfy { String($0.1) == $0.0 }
            && parts[0] == 100 && (64...127).contains(parts[1])
    }
    /// Only active, concrete Tailscale-range IPv4 addresses of local tunnel interfaces; no network request or CLI install.
    static func currentAddresses() -> [String] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return [] }
        defer { freeifaddrs(head) }
        var result = Set<String>(), cursor = head
        while let pointer = cursor {
            defer { cursor = pointer.pointee.ifa_next }
            let entry = pointer.pointee
            guard let addr = entry.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  entry.ifa_flags & UInt32(IFF_UP) != 0,
                  String(cString: entry.ifa_name).hasPrefix("utun") else { continue }
            var bytes = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            let success = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { value in
                inet_ntop(AF_INET, &value.pointee.sin_addr, &bytes, socklen_t(INET_ADDRSTRLEN)) != nil
            }
            guard success else { continue }
            let value = String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            if isPrivateAddress(value) { result.insert(value) }
        }
        return result.sorted()
    }
    func unlocking() -> Self { Self(address: address, custodyFile: custodyFile, installationID: installationID, ownerID: ownerID, generation: generation)! }
}

/// App-domain metadata only. An invalid or changed preference is never repaired or rekeyed on startup.
@MainActor final class LocalAppClientChannelPreferences {
    enum Stored: Equatable {
        case missing
        case saved(address: String, installationID: String, ownerID: String, generation: String? = nil)
        case pending(address: String, installationID: String, ownerID: String, generation: String, creationID: String)
        case inactive(address: String, installationID: String, ownerID: String, generation: String? = nil)
        /// Exact malformed preference snapshot, so one malformed value cannot silently replace another during a CAS.
        case unreadable(fingerprint: String)
    }
    private let defaults: UserDefaults
    private let root: URL?
    init(defaults: UserDefaults = .standard, root: URL? = nil) { self.defaults = defaults; self.root = root }
    private func hash(_ path: String) -> String { SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func key(_ host: URL) -> String { "com.dexter.apple.app-client-channel.v1." + hash(host.path) }
    private func unreadable(_ raw: Any) -> Stored {
        let bytes = (try? PropertyListSerialization.data(fromPropertyList: raw, format: .xml, options: 0)) ?? Data(String(reflecting: type(of: raw)).utf8)
        return .unreadable(fingerprint: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    }
    func load(host: URL) -> Stored {
        guard let raw = defaults.object(forKey: key(host)) else { return .missing }
        guard let value = raw as? [String: String], let address = value["address"], let installationID = value["installationID"], let ownerID = value["ownerID"],
              LocalAppClientChannelConfiguration.isPrivateAddress(address), LocalAppClientChannelConfiguration.isIdentity(installationID),
              LocalAppClientChannelConfiguration.isIdentity(ownerID), value["generation"].map(LocalAppClientChannelConfiguration.isGeneration) ?? true else { return unreadable(raw) }
        let base: Set<String> = ["address", "installationID", "ownerID"]
        let generation = value["generation"]
        let keys = Set(value.keys), identityKeys = generation == nil ? base : base.union(["generation"])
        if keys == identityKeys { return .saved(address: address, installationID: installationID, ownerID: ownerID, generation: generation) }
        if value["state"] == "inactive", keys == identityKeys.union(["state"]) {
            return .inactive(address: address, installationID: installationID, ownerID: ownerID, generation: generation)
        }
        if value["state"] == "pending", let generation, let creationID = value["creationID"],
           LocalAppClientChannelConfiguration.isGeneration(creationID), keys == identityKeys.union(["state", "creationID"]) {
            return .pending(address: address, installationID: installationID, ownerID: ownerID, generation: generation, creationID: creationID)
        }
        return unreadable(raw)
    }
    private func value(_ channel: LocalAppClientChannelConfiguration) -> [String: String] {
        var result = ["address": channel.address, "installationID": channel.installationID, "ownerID": channel.ownerID]
        if let generation = channel.generation { result["generation"] = generation }
        return result
    }
    func save(_ channel: LocalAppClientChannelConfiguration, host: URL, expected: Stored) throws {
        try write(value(channel), host: host, expected: expected,
                  resulting: .saved(address: channel.address, installationID: channel.installationID, ownerID: channel.ownerID, generation: channel.generation))
    }
    func savePending(_ channel: LocalAppClientChannelConfiguration, creationID: String, host: URL, expected: Stored) throws {
        guard let generation = channel.generation, LocalAppClientChannelConfiguration.isGeneration(creationID) else { throw LocalAppClientPreparationFailure.custodyUnavailable }
        var result = value(channel); result["state"] = "pending"; result["creationID"] = creationID
        try write(result, host: host, expected: expected,
                  resulting: .pending(address: channel.address, installationID: channel.installationID, ownerID: channel.ownerID, generation: generation, creationID: creationID))
    }
    /// CAS pointer deactivation only. Ciphertext and Keychain items remain untouched for explicit human recovery.
    func deactivate(_ channel: LocalAppClientChannelConfiguration, host: URL, expected: Stored? = nil) throws {
        var result = value(channel); result["state"] = "inactive"
        try write(result, host: host,
                  expected: expected ?? .saved(address: channel.address, installationID: channel.installationID, ownerID: channel.ownerID, generation: channel.generation),
                  resulting: .inactive(address: channel.address, installationID: channel.installationID, ownerID: channel.ownerID, generation: channel.generation))
    }
    private func write(_ value: [String: String], host: URL, expected: Stored, resulting: Stored) throws {
        guard load(host: host) == expected else { throw LocalAppClientPreparationFailure.custodyUnavailable }
        defaults.set(value, forKey: key(host))
        guard load(host: host) == resulting else { throw LocalAppClientPreparationFailure.custodyUnavailable }
    }
    func configuration(address: String, host: URL, installationID: String, ownerID: String, generation: String? = nil, prepare: Bool = false) throws -> LocalAppClientChannelConfiguration {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
              generation.map(LocalAppClientChannelConfiguration.isGeneration) ?? true,
              LocalAppClientChannelConfiguration.isPrivateAddress(address) else { throw LocalAppClientPreparationFailure.custodyUnavailable }
        let root = self.root ?? support.appendingPathComponent("Dexter App Connections", isDirectory: true)
        let directory = root.appendingPathComponent(hash(host.path), isDirectory: true)
        if prepare {
            for url in [root, directory] {
                if !FileManager.default.fileExists(atPath: url.path) {
                    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                }
                var info = stat()
                guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
                    throw LocalAppClientPreparationFailure.custodyUnavailable
                }
            }
        }
        let filename = "tailscale-\(address)" + (generation.map { ".\($0)" } ?? "")
        guard let result = LocalAppClientChannelConfiguration(address: address,
            custodyFile: directory.appendingPathComponent(filename + ".sealed").path, installationID: installationID, ownerID: ownerID, generation: generation) else { throw LocalAppClientPreparationFailure.custodyUnavailable }
        return result
    }
}
#endif
