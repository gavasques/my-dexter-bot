#if os(macOS)
import Foundation
import CryptoKit
import Security
import LocalAuthentication
import DexterHostClient
import DexterKeychainRuntime

public enum MemoryBackendWrappingStatus: String, Sendable { case missing, configured, unavailable, signingIdentityUnavailable }
public enum MemoryBackendPrivateFailure: Error, Equatable, Sendable {
    case invalidScope, missingWrappingKey, wrappingKeyExists, wrappingKeyUnavailable, signingIdentityUnavailable, bridgeUnavailable, refused, outcomeUnknown
}
public struct MemoryBackendWrappingScope: Equatable, Hashable, Sendable {
    public let hostID: String
    public let ownerID: String
    public let origin: String
    public init(hostID: String, ownerID: String, origin: String) throws {
        guard memoryBackendID(hostID), memoryBackendID(ownerID) else { throw MemoryBackendPrivateFailure.invalidScope }
        self.hostID = hostID; self.ownerID = ownerID; self.origin = try memoryBackendOrigin(origin)
    }
    public var keychainService: String {
        func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
        return "com.dexter.memory-backend.wrapping.v1.host." + hash(hostID) + ".owner." + hash(ownerID) + ".origin." + hash(origin)
    }
}
/// Owned transient bytes. Never Codable, defaults, logs, argv, environment or a clipboard value.
@MainActor public final class MemoryBackendOwnedSecret: CustomStringConvertible {
    private var bytes: Data
    public init?(administrativeKey: String) {
        let value = Data(administrativeKey.utf8)
        guard (1...4096).contains(value.count), !administrativeKey.contains("\0") else { return nil }
        bytes = value
    }
    public init?(wrappingKey: Data) { guard wrappingKey.count == 32 else { return nil }; bytes = wrappingKey }
    func consume<T>(_ operation: (Data) throws -> T) throws -> T { defer { clear() }; return try operation(bytes) }
    public func clear() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll(keepingCapacity: false) }
    public nonisolated var description: String { "MemoryBackendOwnedSecret(redacted)" }
    deinit { bytes.resetBytes(in: 0..<bytes.count) }
}
@MainActor public protocol MemoryBackendWrappingStore: AnyObject {
    func status(scope: MemoryBackendWrappingScope) -> MemoryBackendWrappingStatus
    func create(scope: MemoryBackendWrappingScope) throws -> MemoryBackendOwnedSecret
    func load(scope: MemoryBackendWrappingScope) throws -> MemoryBackendOwnedSecret
}
/// Dedicated non-synchronizing Data Protection Keychain item per host + owner + origin. No update/delete/fallback.
@MainActor public final class NativeScopedWrappingKeychain: MemoryBackendWrappingStore {
    private static let account = "wrapping-32-v1"
    private let runtimeIdentity: () -> RuntimeSigningIdentity
    public init(runtimeIdentity: @escaping () -> RuntimeSigningIdentity = { .current() }) { self.runtimeIdentity=runtimeIdentity }
    private func accessGroup() throws -> String {
        do { return try runtimeIdentity().exactDataProtectionAccessGroup() }
        catch { throw MemoryBackendPrivateFailure.signingIdentityUnavailable }
    }
    private func query(_ scope: MemoryBackendWrappingScope, interaction: Bool) throws -> [CFString:Any] {
        let context = LAContext(); context.interactionNotAllowed = !interaction
        return [kSecClass:kSecClassGenericPassword, kSecAttrService:scope.keychainService, kSecAttrAccount:Self.account,
                kSecAttrAccessGroup:try accessGroup(),kSecAttrSynchronizable:false, kSecUseDataProtectionKeychain:true, kSecUseAuthenticationContext:context]
    }
    private func item(_ scope: MemoryBackendWrappingScope, data: Bool, interaction: Bool) throws -> [CFString:Any]? {
        var request = try query(scope, interaction: interaction); request[kSecReturnAttributes] = true
        request[kSecMatchLimit] = kSecMatchLimitOne
        if data { request[kSecReturnData] = true }
        var output: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &output)
        if status == errSecMissingEntitlement { throw MemoryBackendPrivateFailure.signingIdentityUnavailable }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let value = output as? [CFString:Any],
              value[kSecAttrService] as? String == scope.keychainService, value[kSecAttrAccount] as? String == Self.account,
              value[kSecAttrAccessGroup] as? String == (try accessGroup()),
              value[kSecAttrSynchronizable] as? Bool == false,
              value[kSecAttrAccessible] as? String == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
              data || value[kSecValueData] == nil else { throw MemoryBackendPrivateFailure.wrappingKeyUnavailable }
        return value
    }
    /// Metadata only: no value return, interaction, enumeration or key creation.
    public func status(scope: MemoryBackendWrappingScope) -> MemoryBackendWrappingStatus {
        do { return try item(scope, data: false, interaction: false) == nil ? .missing : .configured }
        catch MemoryBackendPrivateFailure.signingIdentityUnavailable { return .signingIdentityUnavailable }
        catch { return .unavailable }
    }
    /// Explicit owner button only. Duplicate item refuses; never overwrites/rekeys existing ciphertext.
    public func create(scope: MemoryBackendWrappingScope) throws -> MemoryBackendOwnedSecret {
        guard try item(scope, data: false, interaction: true) == nil else { throw MemoryBackendPrivateFailure.wrappingKeyExists }
        var bytes = Data(count: 32); defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard bytes.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw MemoryBackendPrivateFailure.wrappingKeyUnavailable }
        var request = try query(scope, interaction: true)
        request[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly; request[kSecValueData] = bytes
        request[kSecAttrLabel] = "Dexter · Memória privada · wrapping"
        let status = SecItemAdd(request as CFDictionary, nil)
        if status == errSecMissingEntitlement { throw MemoryBackendPrivateFailure.signingIdentityUnavailable }
        if status == errSecDuplicateItem { throw MemoryBackendPrivateFailure.wrappingKeyExists }
        guard status == errSecSuccess, let secret = MemoryBackendOwnedSecret(wrappingKey: bytes) else { throw MemoryBackendPrivateFailure.wrappingKeyUnavailable }
        return secret
    }
    public func load(scope: MemoryBackendWrappingScope) throws -> MemoryBackendOwnedSecret {
        guard let value = try item(scope, data: true, interaction: true) else { throw MemoryBackendPrivateFailure.missingWrappingKey }
        guard var bytes = value[kSecValueData] as? Data else { throw MemoryBackendPrivateFailure.wrappingKeyUnavailable }
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard let secret = MemoryBackendOwnedSecret(wrappingKey: bytes) else { throw MemoryBackendPrivateFailure.wrappingKeyUnavailable }; return secret
    }
}
/// QA injection only, no real Keychain access. Scope isolation and explicit create/load semantics match the port.
@MainActor public final class InMemoryMemoryBackendWrappingStore: MemoryBackendWrappingStore {
    private var values: [MemoryBackendWrappingScope:Data] = [:]
    public private(set) var creates = 0
    public private(set) var loads = 0
    public init() {}
    public func status(scope: MemoryBackendWrappingScope) -> MemoryBackendWrappingStatus { values[scope] == nil ? .missing : .configured }
    public func create(scope: MemoryBackendWrappingScope) throws -> MemoryBackendOwnedSecret {
        guard values[scope] == nil else { throw MemoryBackendPrivateFailure.wrappingKeyExists }
        let bytes = Data(repeating: UInt8((creates+1)%255), count:32); values[scope] = bytes; creates += 1
        return MemoryBackendOwnedSecret(wrappingKey: bytes)!
    }
    public func load(scope: MemoryBackendWrappingScope) throws -> MemoryBackendOwnedSecret {
        guard let bytes = values[scope] else { throw MemoryBackendPrivateFailure.missingWrappingKey }; loads += 1
        return MemoryBackendOwnedSecret(wrappingKey: bytes)!
    }
}
public enum MemoryBackendAdministrativeRole: String, Sendable { case root, workspaceAdmin = "workspace_admin" }
public struct MemoryBackendPrivateIntent: Equatable, Sendable {
    public let requestID: String
    public let scope: MemoryBackendWrappingScope
    public let expectedRevision: Int
    public let operation: MemoryBackendPrivateOperation
    public init(scope: MemoryBackendWrappingScope, expectedRevision: Int, operation: MemoryBackendPrivateOperation, requestID: String = UUID().uuidString.lowercased()) throws {
        guard memoryBackendUUID(requestID), memoryBackendRevision(expectedRevision), expectedRevision > 0 else { throw MemoryBackendPrivateFailure.invalidScope }
        self.requestID = requestID; self.scope = scope; self.expectedRevision = expectedRevision; self.operation = operation
    }
}
@MainActor public final class MemoryBackendPrivateFrame: CustomStringConvertible {
    public let intent: MemoryBackendPrivateIntent
    private var bytes: Data
    private init(intent: MemoryBackendPrivateIntent, object: [String:Any]) throws {
        self.intent = intent; bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys,.withoutEscapingSlashes])
        bytes.append(10); guard bytes.count <= 16384 else { clear(); throw MemoryBackendPrivateFailure.invalidScope }
    }
    private static func common(_ intent: MemoryBackendPrivateIntent) -> [String:Any] {
        ["schema":"dexter.memory-backend-key/1","requestId":intent.requestID,"hostID":intent.scope.hostID,
         "origin":intent.scope.origin,"expectedRevision":intent.expectedRevision,"operation":intent.operation.rawValue]
    }
    public static func create(_ intent: MemoryBackendPrivateIntent, wrapping: MemoryBackendOwnedSecret, administrative: MemoryBackendOwnedSecret, role: MemoryBackendAdministrativeRole) throws -> MemoryBackendPrivateFrame {
        defer { wrapping.clear(); administrative.clear() }
        guard intent.operation == .create else { throw MemoryBackendPrivateFailure.invalidScope }
        return try wrapping.consume { wrap in try administrative.consume { admin in
            guard wrap.count == 32, (1...4096).contains(admin.count), let key = String(data:admin,encoding:.utf8) else { throw MemoryBackendPrivateFailure.invalidScope }
            var object = common(intent); object["wrappingKeyBase64"] = wrap.base64EncodedString(); object["administrativeKey"] = key; object["administrativeRole"] = role.rawValue
            return try MemoryBackendPrivateFrame(intent:intent,object:object)
        } }
    }
    public static func unlock(_ intent: MemoryBackendPrivateIntent, wrapping: MemoryBackendOwnedSecret, role: MemoryBackendAdministrativeRole) throws -> MemoryBackendPrivateFrame {
        defer { wrapping.clear() }; guard intent.operation == .unlock else { throw MemoryBackendPrivateFailure.invalidScope }
        return try wrapping.consume { wrap in
            guard wrap.count == 32 else { throw MemoryBackendPrivateFailure.invalidScope }
            var object = common(intent); object["wrappingKeyBase64"] = wrap.base64EncodedString(); object["administrativeRole"] = role.rawValue
            return try MemoryBackendPrivateFrame(intent:intent,object:object)
        }
    }
    public static func lock(_ intent: MemoryBackendPrivateIntent) throws -> MemoryBackendPrivateFrame {
        guard intent.operation == .lock else { throw MemoryBackendPrivateFailure.invalidScope }; return try MemoryBackendPrivateFrame(intent:intent,object:common(intent))
    }
    func handoff(to child: any LocalHostChild) throws { defer { clear() }; guard !bytes.isEmpty else { throw MemoryBackendPrivateFailure.outcomeUnknown }; try child.provideMemoryBackendKeyFrame(bytes) }
    public func clear() { bytes.resetBytes(in: 0..<bytes.count); bytes.removeAll(keepingCapacity:false) }
    public nonisolated var description: String { "MemoryBackendPrivateFrame(redacted)" }
    deinit { bytes.resetBytes(in:0..<bytes.count) }
}
#endif
