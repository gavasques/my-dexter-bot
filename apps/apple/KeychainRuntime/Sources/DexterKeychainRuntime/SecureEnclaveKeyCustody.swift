import Foundation
import Security
import LocalAuthentication
import CryptoKit

/// Hardware custody for one P-256 signing key: generated inside the Secure Enclave, addressed by an exact tag and
/// access group in the Data Protection Keychain, non-synchronizing, usable only while unlocked on this device.
/// There is no software fallback, no private-key export API and no automatic migration of older software keys.
///
/// Stored protection is verified by exact equality of the item's SecAccessControl with an independently constructed
/// WhenUnlockedThisDeviceOnly + privateKeyUsage control. Secure Enclave items report pdmn "dk" whatever the requested class,
/// so kSecAttrAccessible is not evidence for them. Stored metadata is checked before any key reference is taken, so the live
/// attributes of a software private key (whose dictionary carries the private scalar) are never copied.
public enum SecureEnclaveKeyCustody {
    public static let policy = "secure_enclave_data_protection_keychain_device_only"
    public enum Failure: String, Error, Sendable, Equatable { case hardwareUnavailable, policyUnconfirmed, conflict, locked, missingEntitlement, unavailable }
    public struct Address: Sendable, Equatable {
        public let tag: Data
        /// nil only where the platform has no public API to read the process's own entitlements (iOS); the system default group then applies.
        public let accessGroup: String?
        public init(tag: Data, accessGroup: String?) { self.tag = tag; self.accessGroup = accessGroup }
    }
    public static var hardwareAvailable: Bool { SecureEnclave.isAvailable }

    static func expectedAccessControl() -> SecAccessControl? {
        SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, nil)
    }
    static func context() -> LAContext { let value = LAContext(); value.interactionNotAllowed = true; return value }
    /// No token filter: a key of any token at this exact address must be found, so it is refused rather than shadowed.
    public static func keyQuery(_ address: Address) -> [CFString:Any] {
        var query: [CFString:Any] = [kSecClass:kSecClassKey,kSecAttrKeyClass:kSecAttrKeyClassPrivate,kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag:address.tag,kSecAttrSynchronizable:false,kSecUseDataProtectionKeychain:true,kSecUseAuthenticationContext:context()]
        if let group = address.accessGroup { query[kSecAttrAccessGroup] = group }
        return query
    }
    public static func failure(_ status: OSStatus) -> Failure {
        if status == errSecMissingEntitlement { return .missingEntitlement }
        if status == errSecDuplicateItem { return .conflict }
        if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecNotAvailable { return .locked }
        return .unavailable
    }
    static func securityValue(_ value: Any?, equals expected: CFString) -> Bool {
        if let string = value as? String { return string == expected as String }
        if let number = value as? NSNumber { return number.stringValue == expected as String }
        return false
    }
    /// Keychain booleans: CFBoolean, or an integral CFNumber exactly 0/1 (Secure Enclave items report extr/sync as CFNumber).
    /// Strings, other numbers and absence are not booleans.
    public static func keychainBool(_ value: Any?) -> Bool? {
        guard let value, let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() || CFGetTypeID(number) == CFNumberGetTypeID() else { return nil }
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
        guard !CFNumberIsFloatType(number), number.int64Value == 0 || number.int64Value == 1 else { return nil }
        return number.int64Value == 1
    }
    static func exactBool(_ value: Any?) -> Bool? { keychainBool(value) }

    /// Attributes only: no reference, no value data. nil when absent; more than one match is a conflict.
    public static func storedKeyMetadata(_ address: Address) throws -> [CFString:Any]? {
        var query = keyQuery(address); query[kSecReturnAttributes] = true; query[kSecMatchLimit] = kSecMatchLimitAll
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw failure(status) }
        guard let rows = result as? [[CFString:Any]], rows.count == 1 else { throw Failure.conflict }
        return rows[0]
    }
    /// Exact stored policy. A non-Secure-Enclave token or any protection other than the expected control is policyUnconfirmed.
    public static func checkStored(_ attributes: [CFString:Any], address: Address) throws {
        guard attributes[kSecAttrTokenID] as? String == kSecAttrTokenIDSecureEnclave as String else { throw Failure.policyUnconfirmed }
        guard attributes[kSecValueData] == nil, exactBool(attributes[kSecAttrIsExtractable]) == false else { throw Failure.policyUnconfirmed }
        guard let control = attributes[kSecAttrAccessControl], CFGetTypeID(control as CFTypeRef) == SecAccessControlGetTypeID(),
              let expected = expectedAccessControl(), CFEqual(control as CFTypeRef, expected) else { throw Failure.policyUnconfirmed }
        guard exactBool(attributes[kSecAttrSynchronizable]) == false,
              securityValue(attributes[kSecAttrKeyClass], equals: kSecAttrKeyClassPrivate),
              securityValue(attributes[kSecAttrKeyType], equals: kSecAttrKeyTypeECSECPrimeRandom),
              (attributes[kSecAttrKeySizeInBits] as? NSNumber)?.intValue == 256,
              attributes[kSecAttrApplicationTag] as? Data == address.tag,
              address.accessGroup.map({ attributes[kSecAttrAccessGroup] as? String == $0 }) ?? true,
              let label = attributes[kSecAttrApplicationLabel] as? Data, label.count == 20 else { throw Failure.conflict }
    }
    /// Live Secure Enclave key attributes carry no private material; still required: token, export false, no value data, size,
    /// public-key hash equal to the stored application label.
    public static func checkLive(_ attributes: [CFString:Any], publicKey: Data, stored: [CFString:Any]) throws {
        guard attributes[kSecAttrTokenID] as? String == kSecAttrTokenIDSecureEnclave as String, attributes[kSecValueData] == nil,
              exactBool(attributes[kSecAttrIsExtractable]) == false else { throw Failure.policyUnconfirmed }
        guard (attributes[kSecAttrKeySizeInBits] as? NSNumber)?.intValue == 256, publicKey.count == 65, publicKey.first == 4,
              let label = stored[kSecAttrApplicationLabel] as? Data, Data(Insecure.SHA1.hash(data: publicKey)) == label else { throw Failure.conflict }
    }
    /// Only after the stored item is qualified as Secure Enclave: the reference, its live attributes, binding and possession.
    public static func qualifiedReference(_ address: Address, stored: [CFString:Any]) throws -> (key: SecKey, publicKey: Data) {
        try checkStored(stored, address: address)
        var query = keyQuery(address); query[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave; query[kSecReturnRef] = true; query[kSecMatchLimit] = kSecMatchLimitAll
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { throw status == errSecItemNotFound ? Failure.conflict : failure(status) }
        guard let refs = result as? [CFTypeRef], refs.count == 1, CFGetTypeID(refs[0]) == SecKeyGetTypeID() else { throw Failure.conflict }
        let key = unsafeDowncast(refs[0], to: SecKey.self)
        return (key, try qualifiedLive(key, stored: stored))
    }
    static func qualifiedLive(_ key: SecKey, stored: [CFString:Any]) throws -> Data {
        guard let attributes = SecKeyCopyAttributes(key) as? [CFString:Any], let publicRef = SecKeyCopyPublicKey(key),
              let publicKey = SecKeyCopyExternalRepresentation(publicRef, nil) as Data? else { throw Failure.conflict }
        try checkLive(attributes, publicKey: publicKey, stored: stored)
        try checkPossession(key, publicKey: publicRef)
        return publicKey
    }
    static func checkPossession(_ key: SecKey, publicKey: SecKey) throws {
        var challenge = Data(count: 32)
        guard challenge.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw Failure.unavailable }
        challenge = Data("dexter.secure-enclave.possession.v1\n".utf8) + challenge
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, challenge as CFData, &error) else {
            let code = error.map { CFErrorGetCode($0.takeRetainedValue()) }
            throw code.map { failure(OSStatus($0)) == .locked ? Failure.locked : Failure.policyUnconfirmed } ?? Failure.policyUnconfirmed
        }
        guard SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, challenge as CFData, signature, nil) else { throw Failure.conflict }
    }
    public static func creationParameters(_ address: Address) throws -> [CFString:Any] {
        guard let control = expectedAccessControl() else { throw Failure.unavailable }
        var privateAttributes: [CFString:Any] = [kSecAttrIsPermanent:true,kSecAttrApplicationTag:address.tag,kSecAttrAccessControl:control,kSecAttrSynchronizable:false]
        if let group = address.accessGroup { privateAttributes[kSecAttrAccessGroup] = group }
        return [kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256,kSecAttrTokenID:kSecAttrTokenIDSecureEnclave,
                kSecUseDataProtectionKeychain:true,kSecUseAuthenticationContext:context(),kSecPrivateKeyAttrs:privateAttributes]
    }
    /// Creates and fully qualifies a new key. The caller must first prove the address empty; a partial item is never removed here.
    public static func create(_ address: Address) throws -> (key: SecKey, publicKey: Data) {
        guard hardwareAvailable else { throw Failure.hardwareUnavailable }
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(try creationParameters(address) as CFDictionary, &error) else {
            throw error.map { failure(OSStatus(CFErrorGetCode($0.takeRetainedValue()))) } ?? Failure.unavailable
        }
        guard let stored = try storedKeyMetadata(address) else { throw Failure.conflict }
        try checkStored(stored, address: address)
        return (key, try qualifiedLive(key, stored: stored))
    }
    /// Exact certificate-to-key binding by public key bytes.
    public static func certificate(_ certificate: SecCertificate, binds publicKey: Data) -> Bool {
        guard let certificateKey = SecCertificateCopyKey(certificate), let bytes = SecKeyCopyExternalRepresentation(certificateKey, nil) as Data? else { return false }
        return bytes == publicKey
    }
}
