import Foundation
import CryptoKit

/// Distinguishes an absent snapshot from one that exists but cannot be read as raw bytes.
public enum DexterStoredState {
    case missing
    case data(Data)
    case unreadable
}

/// Synchronous local storage boundary so the app model can be tested with isolated stores.
@MainActor
public protocol DexterAppStateStorage {
    func readData() -> Data?
    func readState() -> DexterStoredState
    func writeData(_ data: Data)
    func removeData()
}

public extension DexterAppStateStorage {
    func readState() -> DexterStoredState {
        readData().map { .data($0) } ?? .missing
    }
}

/// The app stores connection preferences, scoped navigation IDs and idempotency metadata in this key.
/// Message bodies, credentials, health payloads, auth state, and event cursors are never written here.
@MainActor
public final class UserDefaultsDexterAppStateStorage: DexterAppStateStorage {
    public static let defaultKey = "com.dexter.apple.local-app-state.v1"

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String? = nil) {
        self.defaults = defaults
        self.key = key ?? Self.defaultKey
    }

    public func readData() -> Data? {
        defaults.data(forKey: key)
    }

    public func readState() -> DexterStoredState {
        guard let value = defaults.object(forKey: key) else { return .missing }
        guard let data = value as? Data else { return .unreadable }
        return .data(data)
    }

    public func writeData(_ data: Data) {
        defaults.set(data, forKey: key)
    }

    public func removeData() {
        defaults.removeObject(forKey: key)
    }
}

enum DexterStoredConnectionMode: String, Codable, Equatable {
    case fixture
    case loopback
}

struct DexterPendingRequestRecord: Codable, Equatable {
    let hostAddress: String
    let threadID: String
    let clientRequestID: String
    let contentDigest: String
    var attachmentIDs: [String]? = nil
}

/// Navigation only. The identity is matched against a fresh validated health response, never trusted as authority.
struct DexterLastSelectionRecord: Codable, Equatable {
    let hostAddress: String
    let hostIdentity: String
    let botID: String
    let threadID: String?
    var teamID: String? = nil

    func isValid() -> Bool {
        DexterAppStateValidation.validatedLoopbackAddress(hostAddress) == hostAddress
            && DexterAppStateValidation.isSafeThreadID(hostIdentity)
            && DexterAppStateValidation.isSafeThreadID(botID)
            && (threadID.map(DexterAppStateValidation.isSafeThreadID) ?? true)
            && (teamID.map(DexterAppStateValidation.isSafeThreadID) ?? true)
    }
}

struct DexterPersistedAppState: Codable, Equatable {
    static let currentVersion = 1
    static let maxEncodedBytes = 64 * 1_024
    static let maxPendingRequests = 100

    let version: Int
    var mode: DexterStoredConnectionMode
    var loopbackAddress: String?
    var pendingRequests: [DexterPendingRequestRecord]
    var lastSelection: DexterLastSelectionRecord? = nil

    func isValid() -> Bool {
        guard version == Self.currentVersion,
              pendingRequests.count <= Self.maxPendingRequests,
              lastSelection?.isValid() ?? true else { return false }

        if let loopbackAddress, DexterAppStateValidation.validatedLoopbackAddress(loopbackAddress) != loopbackAddress {
            return false
        }
        if mode == .loopback && loopbackAddress == nil { return false }

        var keys = Set<String>()
        for record in pendingRequests {
            guard DexterAppStateValidation.validatedLoopbackAddress(record.hostAddress) == record.hostAddress,
                  DexterAppStateValidation.isSafeThreadID(record.threadID),
                  DexterAppStateValidation.isCanonicalRequestID(record.clientRequestID),
                  DexterAppStateValidation.isSHA256Digest(record.contentDigest) else { return false }
            let attachments = record.attachmentIDs ?? []
            guard attachments.count <= 4, Set(attachments).count == attachments.count,
                  attachments.allSatisfy(DexterAppStateValidation.isCanonicalRequestID) else { return false }
            let key = "\(record.hostAddress)|\(record.threadID)"
            guard keys.insert(key).inserted else { return false }
        }
        return true
    }
}

enum DexterAppStateValidation {
    static func validatedLoopbackAddress(_ rawAddress: String) -> String? {
        let trimmed = rawAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 256,
              var components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "http",
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let urlHost = components.host?.lowercased() else { return nil }
        let rawHost = urlHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard ["localhost", "127.0.0.1", "::1"].contains(rawHost) else { return nil }
        if let port = components.port, !(1...65_535).contains(port) { return nil }

        components.scheme = "http"
        components.host = rawHost.contains(":") ? "[\(rawHost)]" : rawHost
        components.path = ""
        guard let normalized = components.string,
              normalized.utf8.count <= 256 else { return nil }
        return normalized
    }

    static func isSafeThreadID(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 256,
              !value.contains("/"), !value.contains("\\") else { return false }
        return !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    static func isCanonicalRequestID(_ value: String) -> Bool {
        guard let uuid = UUID(uuidString: value) else { return false }
        return uuid.uuidString.lowercased() == value
    }

    static func contentDigest(_ content: String, imageDigests: [String] = []) -> String {
        // Preserve old text-only request digests; image order and every image SHA are part of new requests.
        var data = Data(content.utf8)
        if !imageDigests.isEmpty {
            data = Data("dexter-chat-images-v1\u{0}\(content.utf8.count)\u{0}".utf8) + data
            for digest in imageDigests { data.append(Data("\u{0}\(digest)".utf8)) }
        }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func isSHA256Digest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    static func decode(_ data: Data) -> DexterPersistedAppState? {
        guard data.count <= DexterPersistedAppState.maxEncodedBytes,
              let state = try? JSONDecoder().decode(DexterPersistedAppState.self, from: data),
              state.isValid() else { return nil }
        return state
    }

    static func encode(_ state: DexterPersistedAppState) -> Data? {
        guard state.isValid(),
              let data = try? JSONEncoder().encode(state),
              data.count <= DexterPersistedAppState.maxEncodedBytes else { return nil }
        return data
    }
}
