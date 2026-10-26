import Foundation
import Security
import LocalAuthentication
import DexterKeychainRuntime

/// Secure Enclave key in the Data Protection Keychain of this helper's exact signed access group (SecureEnclaveKeyCustody).
/// No software fallback, login-keychain fallback, migration, regeneration or removal of an existing software/partial item:
/// such state stays quarantined and load-only refuses it. Every query includes the exact Dexter namespace; no broad query.
public actor KeychainIdentityStorage: IdentityStorage {
    private let scope: IdentityScope
    private let runtimeIdentity: @Sendable () -> RuntimeSigningIdentity
    private let secureEnclaveAvailable: @Sendable () -> Bool
    public init(scope: IdentityScope, runtimeIdentity: @escaping @Sendable () -> RuntimeSigningIdentity = { .current() },
                secureEnclaveAvailable: @escaping @Sendable () -> Bool = { SecureEnclaveKeyCustody.hardwareAvailable }) {
        self.scope = scope; self.runtimeIdentity = runtimeIdentity; self.secureEnclaveAvailable = secureEnclaveAvailable
    }
    private func accessGroup() throws -> String {
        do { return try runtimeIdentity().exactDataProtectionAccessGroup() }
        catch { throw IdentityFailure.signingIdentityUnavailable }
    }
    /// Signing context first, then hardware capability; both before any Keychain call.
    private func address() throws -> SecureEnclaveKeyCustody.Address {
        let group = try accessGroup()
        guard secureEnclaveAvailable() else { throw IdentityFailure.nonExportabilityUnconfirmed }
        return .init(tag: scope.tag, accessGroup: group)
    }
    private func context() -> LAContext { let value = LAContext(); value.interactionNotAllowed = true; return value }
    private func certificateQuery(_ group: String) -> [CFString: Any] {
        [kSecClass:kSecClassCertificate,kSecAttrLabel:scope.certificateLabel,kSecAttrAccessGroup:group,kSecAttrSynchronizable:false,
         kSecUseDataProtectionKeychain:true,kSecUseAuthenticationContext:context()]
    }
    private func certificateItem(_ group: String) throws -> (attributes: [CFString:Any], certificate: SecCertificate)? {
        var query = certificateQuery(group); query[kSecReturnRef] = true; query[kSecReturnAttributes] = true; query[kSecMatchLimit] = kSecMatchLimitAll
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary,&result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Self.mapped(SecureEnclaveKeyCustody.failure(status)) }
        guard let rows = result as? [[CFString:Any]], rows.count == 1, let ref = rows[0][kSecValueRef] as CFTypeRef?,
              CFGetTypeID(ref) == SecCertificateGetTypeID() else { throw IdentityFailure.conflict }
        return (rows[0], unsafeDowncast(ref,to:SecCertificate.self))
    }
    static func mapped(_ failure: SecureEnclaveKeyCustody.Failure) -> IdentityFailure {
        switch failure {
        case .hardwareUnavailable, .policyUnconfirmed: return .nonExportabilityUnconfirmed
        case .conflict: return .conflict
        case .locked: return .locked
        case .missingEntitlement: return .signingIdentityUnavailable
        case .unavailable: return .unavailable
        }
    }
    private func custody<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch let failure as SecureEnclaveKeyCustody.Failure { throw Self.mapped(failure) }
    }
    /// Public certificate item: exact label/group, device-only protection, non-synchronizing.
    static func checkStorageAttributes(_ attributes:[CFString:Any]) throws {
        guard attributes[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
              SecureEnclaveKeyCustody.keychainBool(attributes[kSecAttrSynchronizable]) == false else { throw IdentityFailure.conflict }
    }
    public func load(_ requested: IdentityScope) throws -> NativeIdentity? {
        guard requested == scope else { throw IdentityFailure.conflict }
        let address = try address(), group = address.accessGroup!
        let stored = try custody { try SecureEnclaveKeyCustody.storedKeyMetadata(address) }, certificate = try certificateItem(group)
        if stored == nil && certificate == nil { return nil }
        // Incomplete state is never completed, regenerated or removed here.
        guard let stored, let certificate else { throw IdentityFailure.conflict }
        try Self.checkStorageAttributes(certificate.attributes)
        guard certificate.attributes[kSecAttrLabel] as? String == scope.certificateLabel, certificate.attributes[kSecAttrAccessGroup] as? String == group else { throw IdentityFailure.conflict }
        let key = try custody { try SecureEnclaveKeyCustody.qualifiedReference(address, stored: stored) }
        guard SecureEnclaveKeyCustody.certificate(certificate.certificate, binds: key.publicKey) else { throw IdentityFailure.conflict }
        return try NativeIdentity(key:key.key,certificate:certificate.certificate,policy:SecureEnclaveKeyCustody.policy)
    }
    public func provision(_ requested: IdentityScope) throws -> NativeIdentity {
        guard requested == scope else { throw IdentityFailure.conflict }
        let address = try address(), group = address.accessGroup!
        guard try custody({ try SecureEnclaveKeyCustody.storedKeyMetadata(address) }) == nil, try certificateItem(group) == nil else { throw IdentityFailure.conflict }
        // An incomplete provision stays visible and load-only fails; never regenerate or silently remove it.
        let key = try custody { try SecureEnclaveKeyCustody.create(address) }
        let suffix = scope.certificateLabel.split(separator: ".").dropLast().last.map(String.init) ?? "invalid"
        let certificate = try ClientCertificate.make(key:key.key,label:"DexterDevice-"+String(suffix.prefix(16)),now:Date())
        guard SecureEnclaveKeyCustody.certificate(certificate, binds: key.publicKey) else { throw IdentityFailure.conflict }
        var query = certificateQuery(group); query[kSecValueRef] = certificate; query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary,nil)
        guard status == errSecSuccess else { throw Self.mapped(SecureEnclaveKeyCustody.failure(status)) }
        guard let value = try load(scope) else { throw IdentityFailure.conflict }
        return value
    }
    /// LAB ONLY exact namespace cleanup; production removal/rotation requires a separate approved design.
    public func removeLaboratoryItems() throws {
        guard scope.laboratory else { throw IdentityFailure.invalidInput }
        let address = try address(), group = address.accessGroup!
        for query in [certificateQuery(group),SecureEnclaveKeyCustody.keyQuery(address)] {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.mapped(SecureEnclaveKeyCustody.failure(status)) }
        }
    }
}
