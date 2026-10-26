import XCTest
import Security
import CryptoKit
@testable import DexterKeychainRuntime

/// Pure policy checks over attribute dictionaries and independently constructed access controls. No Keychain call,
/// no Secure Enclave key and no private key bytes are involved; physical proof is the signed owned QA in the lab parcel.
final class SecureEnclaveKeyCustodyTests: XCTestCase {
    private let address = SecureEnclaveKeyCustody.Address(tag: Data("com.dexter.synthetic.private".utf8), accessGroup: "ABCDE12345.com.dexter.synthetic")
    private let publicKey = Data([4]) + Data(repeating: 7, count: 64)
    private func control(_ protection: CFString, _ flags: SecAccessControlCreateFlags = .privateKeyUsage) -> SecAccessControl {
        SecAccessControlCreateWithFlags(nil, protection, flags, nil)!
    }
    private func stored() -> [CFString:Any] {
        [kSecAttrTokenID:kSecAttrTokenIDSecureEnclave as String,kSecAttrIsExtractable:false,kSecAttrAccessControl:control(kSecAttrAccessibleWhenUnlockedThisDeviceOnly),
         kSecAttrSynchronizable:false,kSecAttrKeyClass:kSecAttrKeyClassPrivate as String,kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom as String,
         kSecAttrKeySizeInBits:256,kSecAttrApplicationTag:address.tag,kSecAttrAccessGroup:address.accessGroup!,
         kSecAttrApplicationLabel:Data(Insecure.SHA1.hash(data: publicKey)),kSecAttrAccessible:"dk"]
    }
    private func live() -> [CFString:Any] {
        [kSecAttrTokenID:kSecAttrTokenIDSecureEnclave as String,kSecAttrIsExtractable:false,kSecAttrKeySizeInBits:256]
    }
    private func assertFailure(_ expected: SecureEnclaveKeyCustody.Failure, _ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { XCTAssertEqual($0 as? SecureEnclaveKeyCustody.Failure, expected, file: file, line: line) }
    }

    func testCreationParametersRequestExactSecureEnclaveCustody() throws {
        let p = try SecureEnclaveKeyCustody.creationParameters(address)
        XCTAssertEqual(p[kSecAttrTokenID] as? String, kSecAttrTokenIDSecureEnclave as String)
        XCTAssertEqual(p[kSecAttrKeyType] as? String, kSecAttrKeyTypeECSECPrimeRandom as String)
        XCTAssertEqual(p[kSecAttrKeySizeInBits] as? Int, 256)
        XCTAssertEqual(p[kSecUseDataProtectionKeychain] as? Bool, true)
        let privateAttributes = try XCTUnwrap(p[kSecPrivateKeyAttrs] as? [CFString:Any])
        XCTAssertEqual(privateAttributes[kSecAttrIsPermanent] as? Bool, true)
        XCTAssertEqual(privateAttributes[kSecAttrApplicationTag] as? Data, address.tag)
        XCTAssertEqual(privateAttributes[kSecAttrAccessGroup] as? String, address.accessGroup)
        XCTAssertEqual(privateAttributes[kSecAttrSynchronizable] as? Bool, false)
        XCTAssertNil(privateAttributes[kSecAttrAccessible], "protection travels only in the access control")
        let ac = try XCTUnwrap(privateAttributes[kSecAttrAccessControl])
        XCTAssertTrue(CFEqual(ac as CFTypeRef, control(kSecAttrAccessibleWhenUnlockedThisDeviceOnly)))
        let query = SecureEnclaveKeyCustody.keyQuery(address)
        XCTAssertNil(query[kSecAttrTokenID], "lookup must find a software key at the same address so it is refused, not shadowed")
        XCTAssertEqual(query[kSecAttrApplicationTag] as? Data, address.tag); XCTAssertEqual(query[kSecAttrAccessGroup] as? String, address.accessGroup)
    }
    func testAccessControlEqualityDistinguishesProtectionAndFlags() {
        let expected = control(kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
        XCTAssertTrue(CFEqual(expected, control(kSecAttrAccessibleWhenUnlockedThisDeviceOnly)))
        for other in [control(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly), control(kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly),
                      control(kSecAttrAccessibleWhenUnlocked), control(kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence]),
                      control(kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [])] {
            XCTAssertFalse(CFEqual(expected, other))
        }
    }
    func testStoredQualificationAcceptsOnlyExactSecureEnclaveItem() {
        XCTAssertNoThrow(try SecureEnclaveKeyCustody.checkStored(stored(), address: address))
        let unconfirmed: [(CFString, Any?)] = [
            (kSecAttrTokenID, nil), (kSecAttrTokenID, "com.apple.other-token"), (kSecAttrIsExtractable, true), (kSecAttrIsExtractable, nil), (kSecAttrIsExtractable, "false"), (kSecAttrIsExtractable, NSNumber(value: 1)), (kSecAttrIsExtractable, NSNumber(value: 0.0)),
            (kSecValueData, Data([1])), (kSecAttrAccessControl, nil), (kSecAttrAccessControl, "aku"),
            (kSecAttrAccessControl, control(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)), (kSecAttrAccessControl, control(kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly)),
            (kSecAttrAccessControl, control(kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence]))]
        for (key, value) in unconfirmed {
            var bad = stored(); bad[key] = value
            assertFailure(.policyUnconfirmed) { try SecureEnclaveKeyCustody.checkStored(bad, address: address) }
        }
        let conflicting: [(CFString, Any?)] = [
            (kSecAttrSynchronizable, true), (kSecAttrSynchronizable, nil), (kSecAttrSynchronizable, NSNumber(value: 1)), (kSecAttrSynchronizable, NSNumber(value: 2)), (kSecAttrSynchronizable, "0"), (kSecAttrKeyClass, kSecAttrKeyClassPublic as String),
            (kSecAttrKeyType, "foreign"), (kSecAttrKeySizeInBits, 384), (kSecAttrApplicationTag, Data("foreign".utf8)), (kSecAttrAccessGroup, "TESTONLYDe.xter0"),
            (kSecAttrAccessGroup, nil), (kSecAttrApplicationLabel, nil), (kSecAttrApplicationLabel, Data([1, 2]))]
        for (key, value) in conflicting {
            var bad = stored(); bad[key] = value
            assertFailure(.conflict) { try SecureEnclaveKeyCustody.checkStored(bad, address: address) }
        }
    }
    func testObservedSecureEnclaveNumericBooleansAreAcceptedExactly() {
        // Physical QA: Secure Enclave items return extr/sync as CFNumber 0, not CFBoolean.
        var observed = stored(); observed[kSecAttrIsExtractable] = NSNumber(value: 0); observed[kSecAttrSynchronizable] = NSNumber(value: 0)
        XCTAssertNoThrow(try SecureEnclaveKeyCustody.checkStored(observed, address: address))
        var liveObserved = live(); liveObserved[kSecAttrIsExtractable] = NSNumber(value: 0)
        XCTAssertNoThrow(try SecureEnclaveKeyCustody.checkLive(liveObserved, publicKey: publicKey, stored: observed))
        XCTAssertEqual(SecureEnclaveKeyCustody.keychainBool(NSNumber(value: 1)), true); XCTAssertEqual(SecureEnclaveKeyCustody.keychainBool(false), false)
        for bad: Any? in [nil, NSNumber(value: 2), NSNumber(value: -1), NSNumber(value: 0.0), "0", "false", Data([0])] { XCTAssertNil(SecureEnclaveKeyCustody.keychainBool(bad)) }
    }
    func testAccessibleAttributeIsNeverEvidenceForSecureEnclaveProtection() {
        // A manufactured "aku" pdmn does not rescue a wrong access control.
        var bad = stored(); bad[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
        bad[kSecAttrAccessControl] = control(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        assertFailure(.policyUnconfirmed) { try SecureEnclaveKeyCustody.checkStored(bad, address: address) }
    }
    func testLiveQualificationBindsPublicKeyToStoredItem() {
        XCTAssertNoThrow(try SecureEnclaveKeyCustody.checkLive(live(), publicKey: publicKey, stored: stored()))
        for (key, value) in [(kSecAttrTokenID, nil), (kSecAttrIsExtractable, true), (kSecAttrIsExtractable, nil), (kSecValueData, Data([1]))] as [(CFString, Any?)] {
            var bad = live(); bad[key] = value
            assertFailure(.policyUnconfirmed) { try SecureEnclaveKeyCustody.checkLive(bad, publicKey: publicKey, stored: stored()) }
        }
        var size = live(); size[kSecAttrKeySizeInBits] = 384
        assertFailure(.conflict) { try SecureEnclaveKeyCustody.checkLive(size, publicKey: publicKey, stored: stored()) }
        let foreign = Data([4]) + Data(repeating: 8, count: 64)
        assertFailure(.conflict) { try SecureEnclaveKeyCustody.checkLive(live(), publicKey: foreign, stored: stored()) }
        assertFailure(.conflict) { try SecureEnclaveKeyCustody.checkLive(live(), publicKey: Data(repeating: 4, count: 33), stored: stored()) }
    }
    func testStatusMapping() {
        XCTAssertEqual(SecureEnclaveKeyCustody.failure(errSecMissingEntitlement), .missingEntitlement)
        XCTAssertEqual(SecureEnclaveKeyCustody.failure(errSecDuplicateItem), .conflict)
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecNotAvailable] { XCTAssertEqual(SecureEnclaveKeyCustody.failure(status), .locked) }
        XCTAssertEqual(SecureEnclaveKeyCustody.failure(errSecParam), .unavailable)
        XCTAssertEqual(SecureEnclaveKeyCustody.policy, "secure_enclave_data_protection_keychain_device_only")
    }
}
