#if os(macOS)
import Foundation
import CryptoKit
import Security
import LocalAuthentication
import DexterHostClient
import DexterKeychainRuntime

/// Private custody of the connections service capability (the secret behind `credentialRef`). The value lives only in
/// a dedicated Data Protection Keychain item per host + owner + origin + credential generation, and crosses only the
/// owned child's private pipe. Never Codable, defaults, logs, argv, environment, HTTP, a receipt or the clipboard.
public enum ConnectionsPrivateFailure: Error, Equatable, Sendable {
    case invalidScope, missingCapability, capabilityExists, capabilityUnavailable, signingIdentityUnavailable, bridgeUnavailable, refused, outcomeUnknown
}
public enum ConnectionsCapabilityStatus: String, Sendable { case missing, configured, unavailable, signingIdentityUnavailable }
public struct ConnectionsCapabilityScope: Equatable, Hashable, Sendable {
    public let hostID: String
    public let ownerID: String
    public let origin: String
    public let generation: Int
    public init(hostID: String, ownerID: String, origin: String, generation: Int) throws {
        guard memoryBackendID(hostID), memoryBackendID(ownerID), memoryBackendRevision(generation), generation > 0 else { throw ConnectionsPrivateFailure.invalidScope }
        do { self.origin = try connectionsPlatformOrigin(origin) } catch { throw ConnectionsPrivateFailure.invalidScope }
        self.hostID = hostID; self.ownerID = ownerID; self.generation = generation
    }
    public var keychainService: String {
        func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
        return "com.dexter.connections-platform.capability.v1.host." + hash(hostID) + ".owner." + hash(ownerID) + ".origin." + hash(origin)
            + ".generation." + String(generation)
    }
}
/// Owned transient bytes of one capability (entered once by the owner or loaded from custody). Redacted everywhere.
@MainActor public final class ConnectionsOwnedCapability: CustomStringConvertible {
    private var bytes: Data
    public init?(capability: String) {
        guard capability.range(of: "^[A-Za-z0-9._~+/=-]{32,512}$", options: .regularExpression) != nil else { return nil }
        bytes = Data(capability.utf8)
    }
    func consume<T>(_ operation: (Data) throws -> T) throws -> T { defer { clear() }; return try operation(bytes) }
    func read<T>(_ operation: (Data) throws -> T) rethrows -> T { try operation(bytes) }
    public func clear() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll(keepingCapacity: false) }
    public nonisolated var description: String { "ConnectionsOwnedCapability(redacted)" }
    deinit { bytes.resetBytes(in: 0..<bytes.count) }
}
@MainActor public protocol ConnectionsCapabilityStore: AnyObject {
    /// Metadata only: no value return, interaction or enumeration.
    func status(scope: ConnectionsCapabilityScope) -> ConnectionsCapabilityStatus
    /// Explicit owner gesture only. Create-only: an existing item for this exact scope refuses (renewal = new generation).
    func save(scope: ConnectionsCapabilityScope, capability: ConnectionsOwnedCapability) throws
    func load(scope: ConnectionsCapabilityScope) throws -> ConnectionsOwnedCapability
    /// Explicit owner "forget" of this exact scope only.
    func remove(scope: ConnectionsCapabilityScope) throws
}
/// Dedicated non-synchronizing Data Protection Keychain item, exact signed access group (same gates as the memory backend
/// wrapping custody). No update, no fallback to another group, origin or generation.
@MainActor public final class NativeScopedConnectionsCapabilityKeychain: ConnectionsCapabilityStore {
    private static let account = "connections-capability-v1"
    private let runtimeIdentity: () -> RuntimeSigningIdentity
    public init(runtimeIdentity: @escaping () -> RuntimeSigningIdentity = { .current() }) { self.runtimeIdentity = runtimeIdentity }
    private func accessGroup() throws -> String {
        do { return try runtimeIdentity().exactDataProtectionAccessGroup() } catch { throw ConnectionsPrivateFailure.signingIdentityUnavailable }
    }
    private func query(_ scope: ConnectionsCapabilityScope, interaction: Bool) throws -> [CFString: Any] {
        let context = LAContext(); context.interactionNotAllowed = !interaction
        return [kSecClass: kSecClassGenericPassword, kSecAttrService: scope.keychainService, kSecAttrAccount: Self.account,
                kSecAttrAccessGroup: try accessGroup(), kSecAttrSynchronizable: false, kSecUseDataProtectionKeychain: true, kSecUseAuthenticationContext: context]
    }
    private func item(_ scope: ConnectionsCapabilityScope, data: Bool, interaction: Bool) throws -> [CFString: Any]? {
        var request = try query(scope, interaction: interaction); request[kSecReturnAttributes] = true; request[kSecMatchLimit] = kSecMatchLimitOne
        if data { request[kSecReturnData] = true }
        var output: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &output)
        if status == errSecMissingEntitlement { throw ConnectionsPrivateFailure.signingIdentityUnavailable }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let value = output as? [CFString: Any], value[kSecAttrService] as? String == scope.keychainService,
              value[kSecAttrAccount] as? String == Self.account, value[kSecAttrAccessGroup] as? String == (try accessGroup()),
              value[kSecAttrSynchronizable] as? Bool == false, value[kSecAttrAccessible] as? String == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
              data || value[kSecValueData] == nil else { throw ConnectionsPrivateFailure.capabilityUnavailable }
        return value
    }
    public func status(scope: ConnectionsCapabilityScope) -> ConnectionsCapabilityStatus {
        do { return try item(scope, data: false, interaction: false) == nil ? .missing : .configured }
        catch ConnectionsPrivateFailure.signingIdentityUnavailable { return .signingIdentityUnavailable }
        catch { return .unavailable }
    }
    public func save(scope: ConnectionsCapabilityScope, capability: ConnectionsOwnedCapability) throws {
        guard try item(scope, data: false, interaction: true) == nil else { capability.clear(); throw ConnectionsPrivateFailure.capabilityExists }
        var request = try query(scope, interaction: true)
        request[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly; request[kSecAttrLabel] = "Dexter · Serviço de conexões · capability"
        let status: OSStatus = try capability.consume { bytes in request[kSecValueData] = bytes; defer { request[kSecValueData] = nil }; return SecItemAdd(request as CFDictionary, nil) }
        if status == errSecMissingEntitlement { throw ConnectionsPrivateFailure.signingIdentityUnavailable }
        if status == errSecDuplicateItem { throw ConnectionsPrivateFailure.capabilityExists }
        guard status == errSecSuccess else { throw ConnectionsPrivateFailure.capabilityUnavailable }
    }
    public func load(scope: ConnectionsCapabilityScope) throws -> ConnectionsOwnedCapability {
        guard let value = try item(scope, data: true, interaction: false) else { throw ConnectionsPrivateFailure.missingCapability }
        guard var bytes = value[kSecValueData] as? Data else { throw ConnectionsPrivateFailure.capabilityUnavailable }
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard let text = String(data: bytes, encoding: .utf8), let owned = ConnectionsOwnedCapability(capability: text) else { throw ConnectionsPrivateFailure.capabilityUnavailable }
        return owned
    }
    public func remove(scope: ConnectionsCapabilityScope) throws {
        let status = SecItemDelete(try query(scope, interaction: true) as CFDictionary)
        if status == errSecMissingEntitlement { throw ConnectionsPrivateFailure.signingIdentityUnavailable }
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ConnectionsPrivateFailure.capabilityUnavailable }
    }
}
/// QA injection only (no real Keychain). Scope isolation and create-only semantics match the port.
@MainActor public final class InMemoryConnectionsCapabilityStore: ConnectionsCapabilityStore {
    private var values: [ConnectionsCapabilityScope: Data] = [:]
    public private(set) var saves = 0
    public private(set) var loads = 0
    public init() {}
    public func status(scope: ConnectionsCapabilityScope) -> ConnectionsCapabilityStatus { values[scope] == nil ? .missing : .configured }
    public func save(scope: ConnectionsCapabilityScope, capability: ConnectionsOwnedCapability) throws {
        guard values[scope] == nil else { capability.clear(); throw ConnectionsPrivateFailure.capabilityExists }
        values[scope] = try capability.consume { $0 }; saves += 1
    }
    public func load(scope: ConnectionsCapabilityScope) throws -> ConnectionsOwnedCapability {
        guard let bytes = values[scope], let text = String(data: bytes, encoding: .utf8), let owned = ConnectionsOwnedCapability(capability: text)
        else { throw ConnectionsPrivateFailure.missingCapability }
        loads += 1; return owned
    }
    public func remove(scope: ConnectionsCapabilityScope) throws { values[scope] = nil }
}
public struct ConnectionsPrivateIntent: Equatable, Sendable {
    public let requestID: String
    public let scope: ConnectionsCapabilityScope
    public let operation: ConnectionsPrivateOperation
    public init(scope: ConnectionsCapabilityScope, operation: ConnectionsPrivateOperation, requestID: String = UUID().uuidString.lowercased()) throws {
        guard memoryBackendUUID(requestID) else { throw ConnectionsPrivateFailure.invalidScope }
        self.requestID = requestID; self.scope = scope; self.operation = operation
    }
}
/// One-shot frame for the owned child's private pipe (`dexter.connections-capability/1`). Bytes cleared after handoff.
@MainActor public final class ConnectionsPrivateFrame: CustomStringConvertible {
    public static let schema = "dexter.connections-capability/1"
    public static let ackSchema = "dexter.connections-capability-ack/1"
    public let intent: ConnectionsPrivateIntent
    private var bytes: Data
    private init(intent: ConnectionsPrivateIntent, object: [String: Any]) throws {
        self.intent = intent; bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        bytes.append(10); guard bytes.count <= 16_384 else { clear(); throw ConnectionsPrivateFailure.invalidScope }
    }
    private static func common(_ intent: ConnectionsPrivateIntent) -> [String: Any] {
        ["schema": schema, "requestId": intent.requestID, "hostID": intent.scope.hostID, "operation": intent.operation.rawValue,
         "origin": intent.scope.origin, "generation": intent.scope.generation]
    }
    public static func set(_ intent: ConnectionsPrivateIntent, capability: ConnectionsOwnedCapability) throws -> ConnectionsPrivateFrame {
        defer { capability.clear() }
        guard intent.operation == .set else { throw ConnectionsPrivateFailure.invalidScope }
        return try capability.consume { data in
            guard let text = String(data: data, encoding: .utf8) else { throw ConnectionsPrivateFailure.invalidScope }
            var object = common(intent); object["capability"] = text
            return try ConnectionsPrivateFrame(intent: intent, object: object)
        }
    }
    public static func lock(_ intent: ConnectionsPrivateIntent) throws -> ConnectionsPrivateFrame {
        guard intent.operation == .lock else { throw ConnectionsPrivateFailure.invalidScope }
        return try ConnectionsPrivateFrame(intent: intent, object: common(intent))
    }
    func handoff(to child: any LocalHostChild) throws {
        defer { clear() }; guard !bytes.isEmpty else { throw ConnectionsPrivateFailure.outcomeUnknown }; try child.provideConnectionsCapabilityFrame(bytes)
    }
    /// Test/QA seam: the exact bytes handed to a pipe-like sink, then cleared.
    public func handoff(_ sink: (Data) throws -> Void) throws { defer { clear() }; guard !bytes.isEmpty else { throw ConnectionsPrivateFailure.outcomeUnknown }; try sink(bytes) }
    public func clear() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll(keepingCapacity: false) }
    public nonisolated var description: String { "ConnectionsPrivateFrame(redacted)" }
    deinit { bytes.resetBytes(in: 0..<bytes.count) }
}
/// Nonsecret channel to the owned child; retained across Settings closes. Secrets belong only to a one-shot frame.
@MainActor public struct ConnectionsPrivateChannel {
    public let available: (String) -> Bool
    public let send: (ConnectionsPrivateFrame) async throws -> Void
    public let reconcile: (ConnectionsPrivateIntent, ConnectionsConfigurationStatus) -> Bool
    public let uncertain: () -> ConnectionsPrivateIntent?
    public init(available: @escaping (String) -> Bool, send: @escaping (ConnectionsPrivateFrame) async throws -> Void,
                reconcile: @escaping (ConnectionsPrivateIntent, ConnectionsConfigurationStatus) -> Bool, uncertain: @escaping () -> ConnectionsPrivateIntent?) {
        self.available = available; self.send = send; self.reconcile = reconcile; self.uncertain = uncertain
    }
}
#endif
