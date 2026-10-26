import XCTest
import DexterKeychainRuntime
@testable import DexterDeviceIdentity

/// Ordering gates proven without Keychain: a valid-looking signing context with no Secure Enclave refuses before any SecItem call
/// (an unsigned test process reaching the Keychain would instead get errSecMissingEntitlement -> signingIdentityUnavailable).
@MainActor final class SecureEnclaveGateTests: XCTestCase {
    private let signed = RuntimeSigningIdentity(validityStatus:0,bundleIdentifier:"com.dexter.synthetic",codeIdentifier:"com.dexter.synthetic",teamIdentifier:"ABCDE12345",
        applicationIdentifier:"ABCDE12345.com.dexter.synthetic",accessGroups:["ABCDE12345.com.dexter.synthetic"])
    func testUnsupportedHardwareRefusesHonestlyBeforeKeychainCertificateOrTransport() async throws {
        let scope = try IdentityScope(installationID:"se-gate-fixture",laboratoryID:String(repeating:"d",count:32))
        let signed = self.signed
        let store = KeychainIdentityStorage(scope:scope,runtimeIdentity:{signed},secureEnclaveAvailable:{false})
        for operation in ["load","provision","remove"] {
            do {
                switch operation { case "load": _ = try await store.load(scope); case "provision": _ = try await store.provision(scope); default: try await store.removeLaboratoryItems() }
                XCTFail("\(operation) without Secure Enclave must not succeed")
            } catch { XCTAssertEqual(error as? IdentityFailure,.nonExportabilityUnconfirmed,operation) }
        }
        let lifecycle = IdentityLifecycle(scope:scope,storage:store)
        let host = try NativeIdentity.ephemeralFixture()
        let request = try PreparedDeviceRequest(route:DeviceRoute.poll.rawValue,bodyBase64:"e30=",hostURL:"https://127.0.0.1:1",hostCertificateDER:host.certificateDER.base64EncodedString(),
            hostFingerprint:host.fingerprint,timeoutSeconds:1,expectedClientFingerprint:String(repeating:"1",count:64))
        do { _ = try await request.perform(lifecycle:lifecycle); XCTFail("transport reached") } catch { XCTAssertEqual(error as? IdentityFailure,.nonExportabilityUnconfirmed) }
    }
    func testCustodyFailuresMapToExistingWireValues() {
        XCTAssertEqual(KeychainIdentityStorage.mapped(.hardwareUnavailable),.nonExportabilityUnconfirmed)
        XCTAssertEqual(KeychainIdentityStorage.mapped(.policyUnconfirmed),.nonExportabilityUnconfirmed)
        XCTAssertEqual(KeychainIdentityStorage.mapped(.missingEntitlement),.signingIdentityUnavailable)
        XCTAssertEqual(KeychainIdentityStorage.mapped(.locked),.locked)
        XCTAssertEqual(KeychainIdentityStorage.mapped(.conflict),.conflict)
        XCTAssertEqual(KeychainIdentityStorage.mapped(.unavailable),.unavailable)
    }
    func testIdentityRequiresExactCertificateToKeyBinding() throws {
        var error: Unmanaged<CFError>?
        let one = try XCTUnwrap(SecKeyCreateRandomKey([kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256] as CFDictionary,&error))
        let two = try XCTUnwrap(SecKeyCreateRandomKey([kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256] as CFDictionary,&error))
        let certificate = try ClientCertificate.make(key:one,label:"DexterSynthetic",now:Date())
        XCTAssertNoThrow(try NativeIdentity(key:one,certificate:certificate,policy:"ephemeral_fixture_only"))
        XCTAssertThrowsError(try NativeIdentity(key:two,certificate:certificate,policy:"ephemeral_fixture_only")) { XCTAssertEqual($0 as? IdentityFailure,.conflict) }
        let publicKey = try XCTUnwrap(SecKeyCopyExternalRepresentation(try XCTUnwrap(SecKeyCopyPublicKey(one)),nil) as Data?)
        XCTAssertTrue(SecureEnclaveKeyCustody.certificate(certificate,binds:publicKey))
        XCTAssertFalse(SecureEnclaveKeyCustody.certificate(certificate,binds:Data([4])+Data(repeating:9,count:64)))
    }
}
