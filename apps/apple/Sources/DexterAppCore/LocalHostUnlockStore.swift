#if os(macOS)
import Foundation
import Security
import LocalAuthentication
import DexterKeychainRuntime

@MainActor public protocol LocalHostUnlockStore: AnyObject {
    func status(scope: LocalHostUnlockScope) -> LocalHostUnlockStatus
    func create(scope: LocalHostUnlockScope, creationId: String) throws -> OwnedLocalHostUnlockBytes
    func load(scope: LocalHostUnlockScope) throws -> OwnedLocalHostUnlockBytes
    func creationInfo(scope: LocalHostUnlockScope) throws -> LocalHostUnlockCreationInfo?
    func loadPendingCreation(scope: LocalHostUnlockScope, expectedCreationId: String) throws -> OwnedLocalHostUnlockBytes
}
extension LocalHostUnlockStore {
    public func create(scope: LocalHostUnlockScope) throws -> OwnedLocalHostUnlockBytes { try create(scope: scope, creationId: UUID().uuidString) }
}
struct LocalHostUnlockQuery { let scope: LocalHostUnlockScope; let accessGroup: String; let returnsValue: Bool; let interactionNotAllowed: Bool; var creationId: String? = nil }
@MainActor protocol LocalHostUnlockKeychainBackend {
    func lookup(_ query: LocalHostUnlockQuery) throws -> [CFString: Any]?
    func insert(_ query: LocalHostUnlockQuery, bytes: Data) throws
}
@MainActor private struct SecurityLocalHostUnlockBackend: LocalHostUnlockKeychainBackend {
    func lookup(_ query: LocalHostUnlockQuery) throws -> [CFString: Any]? {
        var request = LocalHostUnlockAttributes.query(scope: query.scope, accessGroup: query.accessGroup, returnsValue: query.returnsValue)
        let context = LAContext(); context.interactionNotAllowed = query.interactionNotAllowed
        request[kSecUseAuthenticationContext] = context
        var output: CFTypeRef?
        let result = SecItemCopyMatching(request as CFDictionary, &output)
        if result == errSecItemNotFound { return nil }
        try check(result)
        guard let value = output as? [CFString: Any] else { throw LocalHostUnlockFailure.conflict }
        return value
    }
    func insert(_ query: LocalHostUnlockQuery, bytes: Data) throws {
        guard let creationId = query.creationId else { throw LocalHostUnlockFailure.invalidScope }
        var request = try LocalHostUnlockAttributes.creation(scope: query.scope, accessGroup: query.accessGroup, creationId: creationId)
        let context = LAContext(); context.interactionNotAllowed = query.interactionNotAllowed
        request[kSecUseAuthenticationContext] = context; request[kSecValueData] = bytes
        try check(SecItemAdd(request as CFDictionary, nil))
    }
    private func check(_ status: OSStatus) throws {
        switch status {
        case errSecSuccess: return
        case errSecDuplicateItem: throw LocalHostUnlockFailure.alreadyExists
        case errSecMissingEntitlement: throw LocalHostUnlockFailure.signingIdentityUnavailable
        case errSecInteractionNotAllowed, errSecAuthFailed: throw LocalHostUnlockFailure.locked
        default: throw LocalHostUnlockFailure.unavailable
        }
    }
}
/// Dedicated app/file GenericPassword custodian. No public signer override, enumeration, update/delete,
/// rekey, old-Keychain fallback or startup create. Root calls create only from its human setup action.
@MainActor public final class NativeLocalHostUnlockStore: LocalHostUnlockStore {
    private let runtimeIdentity: () -> RuntimeSigningIdentity
    private let backend: any LocalHostUnlockKeychainBackend
    private let random: () throws -> Data
    public init() {
        runtimeIdentity = { .current() }; backend = SecurityLocalHostUnlockBackend()
        random = {
            var bytes = Data(count: 32)
            guard bytes.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else {
                bytes.resetBytes(in: 0..<bytes.count); throw LocalHostUnlockFailure.unavailable
            }
            return bytes
        }
    }
    /// Test seam requires the entire backend and random generator. No fake signer can reach native Security.
    init(runtimeIdentity: @escaping () -> RuntimeSigningIdentity, backend: any LocalHostUnlockKeychainBackend,
         random: @escaping () throws -> Data) { self.runtimeIdentity = runtimeIdentity; self.backend = backend; self.random = random }
    private func query(_ scope: LocalHostUnlockScope, value: Bool, interactionNotAllowed: Bool) throws -> LocalHostUnlockQuery {
        let identity = runtimeIdentity()
        let group: String
        do { group = try identity.exactDataProtectionAccessGroup() } catch { throw LocalHostUnlockFailure.signingIdentityUnavailable }
        guard identity.bundleIdentifier == scope.bundleID else { throw LocalHostUnlockFailure.scopeMismatch }
        _ = try scope.fileState()
        return .init(scope: scope, accessGroup: group, returnsValue: value, interactionNotAllowed: interactionNotAllowed)
    }
    private func item(_ query: LocalHostUnlockQuery) throws -> [CFString: Any]? {
        guard let value = try backend.lookup(query) else { return nil }
        try LocalHostUnlockAttributes.validate(value, scope: query.scope, accessGroup: query.accessGroup, returnsValue: query.returnsValue)
        return value
    }
    public func status(scope: LocalHostUnlockScope) -> LocalHostUnlockStatus {
        do {
            let query = try query(scope, value: false, interactionNotAllowed: true), before = try scope.fileState()
            let exists = try item(query) != nil
            guard try scope.fileState() == before else { return .blocked }
            switch (before, exists) {
            case (.absent, false): return .missing
            case (.absent, true): return .blocked // Key exists without ciphertext: partial, not automatic create.
            case (.present, false): return .legacyPasswordRequired
            case (.present, true): return .configured
            }
        } catch { return .blocked }
    }
    public func create(scope: LocalHostUnlockScope, creationId: String) throws -> OwnedLocalHostUnlockBytes {
        let id = try LocalHostUnlockAttributes.normalizedCreationId(creationId)
        var query = try query(scope, value: false, interactionNotAllowed: false); query.creationId = id
        guard try item(query) == nil else { throw LocalHostUnlockFailure.alreadyExists }
        guard try scope.fileState() == .absent else { throw LocalHostUnlockFailure.legacyPasswordRequired }
        var bytes = try random(); defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard bytes.count == 32 else { throw LocalHostUnlockFailure.unavailable }
        guard try scope.fileState() == .absent else { throw LocalHostUnlockFailure.conflict }
        try backend.insert(query, bytes: bytes) // Atomic create-only duplicate semantics, never an update.
        guard try scope.fileState() == .absent else { throw LocalHostUnlockFailure.outcomeUnknown }
        guard let value = OwnedLocalHostUnlockBytes(bytes: bytes, creationId: id) else { throw LocalHostUnlockFailure.unavailable }
        return value
    }
    public func load(scope: LocalHostUnlockScope) throws -> OwnedLocalHostUnlockBytes {
        let query = try query(scope, value: true, interactionNotAllowed: true), before = try scope.fileState()
        guard before != .absent else { throw LocalHostUnlockFailure.conflict }
        guard var value = try item(query) else { throw LocalHostUnlockFailure.legacyPasswordRequired }
        guard var bytes = value.removeValue(forKey: kSecValueData) as? Data else { throw LocalHostUnlockFailure.conflict }
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard try scope.fileState() == before else { throw LocalHostUnlockFailure.conflict }
        guard let secret = OwnedLocalHostUnlockBytes(bytes: bytes) else { throw LocalHostUnlockFailure.conflict }; return secret
    }
    /// Public creation association only: exact scoped item, no secret value, interaction or writes.
    public func creationInfo(scope: LocalHostUnlockScope) throws -> LocalHostUnlockCreationInfo? {
        let query = try query(scope, value: false, interactionNotAllowed: true), before = try scope.fileState()
        guard let value = try item(query) else { return nil }
        guard try scope.fileState() == before else { throw LocalHostUnlockFailure.conflict }
        return try LocalHostUnlockAttributes.creationInfo(value, scope: scope)
    }
    /// HUMAN RESUME ONLY. Read-only, same original ID/bytes, no creation/rekey or startup use.
    /// Root must bind this call to a reviewed native gesture and current owned host/filesystem scope.
    public func loadPendingCreation(scope: LocalHostUnlockScope, expectedCreationId: String) throws -> OwnedLocalHostUnlockBytes {
        let expected = try LocalHostUnlockAttributes.normalizedCreationId(expectedCreationId)
        let metadataQuery = try query(scope, value: false, interactionNotAllowed: true)
        guard try scope.fileState() == .absent else { throw LocalHostUnlockFailure.conflict } // Existing sealed file uses ordinary load only.
        guard let metadata = try item(metadataQuery) else { throw LocalHostUnlockFailure.missing }
        let captured = try LocalHostUnlockAttributes.creationInfo(metadata, scope: scope)
        guard captured.creationId == expected else { throw LocalHostUnlockFailure.conflict } // Wrong ID never returns/requests value bytes.
        let query = try query(scope, value: true, interactionNotAllowed: true)
        guard var value = try item(query) else { throw LocalHostUnlockFailure.missing }
        let info = try LocalHostUnlockAttributes.creationInfo(value, scope: scope)
        guard var bytes = value.removeValue(forKey: kSecValueData) as? Data else { throw LocalHostUnlockFailure.conflict }
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard info == captured, try scope.fileState() == .absent else { throw LocalHostUnlockFailure.conflict }
        guard let secret = OwnedLocalHostUnlockBytes(bytes: bytes, creationId: info.creationId) else { throw LocalHostUnlockFailure.conflict }; return secret
    }
}
#endif
