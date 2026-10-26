import Foundation
import Security
import LocalAuthentication
import DexterKeychainRuntime

/// Compiled production policy: Secure Enclave key custody (SecureEnclaveKeyCustody) with a device-only public certificate.
/// No software fallback, migration, regeneration or removal; older software or partial items stay quarantined and refuse.
/// macOS derives the exact access group from this process's own signature. iOS has no public API to read its own
/// entitlements, so the system default group of the app applies there (compiled only; no iOS runtime proof is claimed).
public actor SecureEnclaveDataProtectionKeychain: ClientIdentityStorage {
    private let scope: ClientIdentityScope
    private let accessGroup: @Sendable () throws -> String?
    private let secureEnclaveAvailable: @Sendable () -> Bool
    #if os(macOS)
    public init(scope: ClientIdentityScope, runtimeIdentity: @escaping @Sendable () -> RuntimeSigningIdentity = { .current() },
                secureEnclaveAvailable: @escaping @Sendable () -> Bool = { SecureEnclaveKeyCustody.hardwareAvailable }) {
        self.scope = scope; self.secureEnclaveAvailable = secureEnclaveAvailable
        accessGroup = { do { return try runtimeIdentity().exactDataProtectionAccessGroup() } catch { throw ClientIdentityFailure.unavailable } }
    }
    #else
    public init(scope: ClientIdentityScope, secureEnclaveAvailable: @escaping @Sendable () -> Bool = { SecureEnclaveKeyCustody.hardwareAvailable }) {
        self.scope = scope; self.secureEnclaveAvailable = secureEnclaveAvailable; accessGroup = { nil }
    }
    #endif
    /// Signing context first, then hardware capability; both before any Keychain call.
    private func address() throws -> SecureEnclaveKeyCustody.Address {
        let group = try accessGroup()
        guard secureEnclaveAvailable() else { throw ClientIdentityFailure.policyUnconfirmed }
        return .init(tag: scope.tag, accessGroup: group)
    }
    private func context() -> LAContext { let context = LAContext(); context.interactionNotAllowed = true; return context }
    private func certificateQuery(_ group: String?) -> [CFString:Any] {
        var query: [CFString:Any] = [kSecClass:kSecClassCertificate,kSecAttrLabel:scope.certificateLabel,kSecAttrSynchronizable:false,
         kSecUseDataProtectionKeychain:true,kSecUseAuthenticationContext:context()]
        if let group { query[kSecAttrAccessGroup] = group }
        return query
    }
    static func mapped(_ failure: SecureEnclaveKeyCustody.Failure) -> ClientIdentityFailure {
        switch failure {
        case .hardwareUnavailable, .policyUnconfirmed: return .policyUnconfirmed
        case .conflict: return .conflict
        case .locked: return .locked
        case .missingEntitlement, .unavailable: return .unavailable
        }
    }
    private func custody<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch let failure as SecureEnclaveKeyCustody.Failure { throw Self.mapped(failure) }
    }
    private func certificateItem(_ group: String?) throws -> [CFString:Any]? {
        var query = certificateQuery(group); query[kSecReturnRef] = true; query[kSecReturnAttributes] = true; query[kSecMatchLimit] = kSecMatchLimitAll
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary,&result)
        if status == errSecItemNotFound { return nil }; guard status == errSecSuccess else { throw Self.mapped(SecureEnclaveKeyCustody.failure(status)) }
        guard let values = result as? [[CFString:Any]], values.count == 1 else { throw ClientIdentityFailure.conflict }
        return values[0]
    }
    /// Public certificate item: device-only protection, explicit non-synchronizing attribute.
    static func checkedStorage(_ attributes: [CFString:Any]) throws {
        guard attributes[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
              SecureEnclaveKeyCustody.keychainBool(attributes[kSecAttrSynchronizable]) == false else { throw ClientIdentityFailure.conflict }
    }
    public func load(_ requested: ClientIdentityScope) throws -> ClientNativeIdentity? {
        guard requested == scope else { throw ClientIdentityFailure.conflict }
        let address = try address()
        let stored = try custody { try SecureEnclaveKeyCustody.storedKeyMetadata(address) }, certificate = try certificateItem(address.accessGroup)
        if stored == nil && certificate == nil { return nil }
        guard let stored, let certificate else { throw ClientIdentityFailure.incomplete }
        try Self.checkedStorage(certificate)
        guard certificate[kSecAttrLabel] as? String == scope.certificateLabel,
              address.accessGroup.map({ certificate[kSecAttrAccessGroup] as? String == $0 }) ?? true,
              let certificateRef = certificate[kSecValueRef] as CFTypeRef?, CFGetTypeID(certificateRef) == SecCertificateGetTypeID() else { throw ClientIdentityFailure.conflict }
        let key = try custody { try SecureEnclaveKeyCustody.qualifiedReference(address, stored: stored) }
        let cert = unsafeDowncast(certificateRef,to:SecCertificate.self)
        guard SecureEnclaveKeyCustody.certificate(cert, binds: key.publicKey) else { throw ClientIdentityFailure.conflict }
        return try ClientNativeIdentity(key:key.key,certificate:cert,policy:SecureEnclaveKeyCustody.policy)
    }
    public func provision(_ requested: ClientIdentityScope) throws -> ClientNativeIdentity {
        guard requested == scope else { throw ClientIdentityFailure.conflict }
        let address = try address()
        guard try custody({ try SecureEnclaveKeyCustody.storedKeyMetadata(address) }) == nil, try certificateItem(address.accessGroup) == nil else { throw ClientIdentityFailure.conflict }
        // Any partial state remains quarantined; there is no automatic delete/rotate/fallback.
        let key = try custody { try SecureEnclaveKeyCustody.create(address) }
        let certificate = try ClientCertificate.make(key:key.key,label:"DexterClient-"+String(sha256(scope.tag).prefix(16)),now:Date())
        guard SecureEnclaveKeyCustody.certificate(certificate, binds: key.publicKey) else { throw ClientIdentityFailure.conflict }
        var query = certificateQuery(address.accessGroup); query[kSecValueRef] = certificate; query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary,nil); guard status == errSecSuccess else { throw Self.mapped(SecureEnclaveKeyCustody.failure(status)) }
        guard let identity = try load(scope) else { throw ClientIdentityFailure.incomplete }; return identity
    }
}
