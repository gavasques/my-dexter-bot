import XCTest
import DexterKeychainRuntime
import Foundation
import Security
@testable import DexterClientIdentity

actor MemoryStorage: ClientIdentityStorage {
    var identities: [Data:ClientNativeIdentity] = [:]
    var loads = 0, provisions = 0
    var failure: ClientIdentityFailure?
    func load(_ scope: ClientIdentityScope) throws -> ClientNativeIdentity? { loads += 1; if let failure { throw failure }; return identities[scope.tag] }
    func provision(_ scope: ClientIdentityScope) throws -> ClientNativeIdentity { provisions += 1; guard identities[scope.tag] == nil else { throw ClientIdentityFailure.conflict }; let identity = try ClientNativeIdentity.ephemeralFixture(); identities[scope.tag] = identity; return identity }
    func install(_ scope: ClientIdentityScope, identity: ClientNativeIdentity) { identities[scope.tag] = identity }
    func setFailure(_ failure: ClientIdentityFailure?) { self.failure = failure }
    func counts() -> [Int] { [loads,provisions] }
}
@MainActor final class IdentityTests: XCTestCase {
    func scope(_ installation: String = "host_fixture", _ binding: String = String(repeating:"a",count:32), _ role: ClientRole = .clientIOS) throws -> ClientIdentityScope { try .init(installationID:installation,localBindingID:binding,role:role,hostFingerprint:String(repeating:"a",count:64)) }
    func testNamespaceSeparatesAgentInstallBindingAndRole() throws {
        let one = try scope(); XCTAssertTrue(String(decoding:one.tag,as:UTF8.self).hasPrefix("com.dexter.app-client-identity.v1."))
        XCTAssertFalse(String(decoding:one.tag,as:UTF8.self).hasPrefix("com.dexter.device-identity.v1."))
        for other in [try scope("host_other"),try scope("host_fixture",String(repeating:"b",count:32)),try scope("host_fixture",String(repeating:"a",count:32),.clientMac)] { XCTAssertNotEqual(one.tag,other.tag); XCTAssertNotEqual(one.certificateLabel,other.certificateLabel) }
        XCTAssertEqual(try scope(),one); XCTAssertEqual(ClientIdentityScope.newLocalBindingID().count,32)
        for id in ["","host\n","../host",String(repeating:"x",count:129)] { XCTAssertThrowsError(try scope(id)) }
        for binding in ["","a",String(repeating:"A",count:32),String(repeating:"a",count:31)+"\n"] { XCTAssertThrowsError(try scope("host",binding)) }
    }
    func testLoadOnlyMissingNeverProvisionsAndRestartsKeepSameIdentity() async throws {
        let storage = MemoryStorage(), fixed = try scope(), lifecycle = ClientIdentityLifecycle(scope:fixed,storage:storage)
        do { _ = try await lifecycle.loadOnly(); XCTFail("missing identity admitted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.missing) }
        let before = await storage.counts(); XCTAssertEqual(before,[1,0])
        let one = try await lifecycle.provisionExplicitly(), recreated = ClientIdentityLifecycle(scope:fixed,storage:storage)
        let recovered = try await recreated.loadOnly(); XCTAssertEqual(recovered.fingerprint,one.fingerprint)
        do { _ = try await recreated.provisionExplicitly(); XCTFail("rotated existing identity") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        let counts = await storage.counts(); XCTAssertEqual(counts,[4,1])
        do { _ = try await ClientIdentityLifecycle(scope:scope("other"),storage:storage).loadOnly(); XCTFail("cross-install identity") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.missing) }
        let finalCounts = await storage.counts(); XCTAssertEqual(finalCounts,[5,1])
    }
    func testLockedIncompleteConflictDoNotFallback() async throws {
        let storage = MemoryStorage(), lifecycle = ClientIdentityLifecycle(scope:try scope(),storage:storage)
        for failure in [ClientIdentityFailure.locked,.incomplete,.conflict,.unavailable] {
            await storage.setFailure(failure)
            do { _ = try await lifecycle.loadOnly(); XCTFail("storage error hidden") } catch { XCTAssertEqual(error as? ClientIdentityFailure,failure) }
        }
        let counts = await storage.counts(); XCTAssertEqual(counts,[4,0])
    }
    func testSecureEnclaveStorageRefusesUnsupportedHardwareAndUnsignedContextBeforeKeychain() async throws {
        let scope = try scope()
        #if os(macOS)
        let signed = RuntimeSigningIdentity(validityStatus:0,bundleIdentifier:"com.dexter.synthetic",codeIdentifier:"com.dexter.synthetic",teamIdentifier:"ABCDE12345",
            applicationIdentifier:"ABCDE12345.com.dexter.synthetic",accessGroups:["ABCDE12345.com.dexter.synthetic"])
        let noHardware = SecureEnclaveDataProtectionKeychain(scope:scope,runtimeIdentity:{signed},secureEnclaveAvailable:{false})
        let unsigned = SecureEnclaveDataProtectionKeychain(scope:scope,runtimeIdentity:{RuntimeSigningIdentity(validityStatus:0,bundleIdentifier:nil,codeIdentifier:"cli",teamIdentifier:nil,applicationIdentifier:nil,accessGroups:[])},secureEnclaveAvailable:{true})
        for (store,expected) in [(noHardware,ClientIdentityFailure.policyUnconfirmed),(unsigned,.unavailable)] {
            do { _ = try await store.load(scope); XCTFail("load") } catch { XCTAssertEqual(error as? ClientIdentityFailure,expected) }
            do { _ = try await store.provision(scope); XCTFail("provision") } catch { XCTAssertEqual(error as? ClientIdentityFailure,expected) }
        }
        #endif
        XCTAssertEqual(SecureEnclaveDataProtectionKeychain.mapped(.hardwareUnavailable),.policyUnconfirmed)
        XCTAssertEqual(SecureEnclaveDataProtectionKeychain.mapped(.policyUnconfirmed),.policyUnconfirmed)
        XCTAssertEqual(SecureEnclaveDataProtectionKeychain.mapped(.locked),.locked)
        XCTAssertEqual(SecureEnclaveDataProtectionKeychain.mapped(.missingEntitlement),.unavailable)
    }
    func testCertificateItemStorageIsDeviceOnlyAndExplicitlyNonSynchronizing() {
        XCTAssertNoThrow(try SecureEnclaveDataProtectionKeychain.checkedStorage([kSecAttrAccessible:kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,kSecAttrSynchronizable:false]))
        for bad in [[kSecAttrAccessible:kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String],[kSecAttrAccessible:kSecAttrAccessibleAfterFirstUnlock as String,kSecAttrSynchronizable:false],
                    [kSecAttrAccessible:kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,kSecAttrSynchronizable:true]] as [[CFString:Any]] {
            XCTAssertThrowsError(try SecureEnclaveDataProtectionKeychain.checkedStorage(bad)) { XCTAssertEqual($0 as? ClientIdentityFailure,.conflict) }
        }
    }
    func testEphemeralCertificateValidityAndMatchingKey() throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(); XCTAssertEqual(identity.fingerprint,sha256(identity.certificateDER))
        XCTAssertNoThrow(try CertificateProfile.validate(identity.certificateDER,usage:.client,now:Date()))
        XCTAssertThrowsError(try CertificateProfile.validate(identity.certificateDER,usage:.server,now:Date()))
        XCTAssertThrowsError(try CertificateProfile.validate(identity.certificateDER,usage:.client,now:Date().addingTimeInterval(366*86400)))
        let foreign = try ClientNativeIdentity.ephemeralFixture(); XCTAssertNotEqual(identity.fingerprint,foreign.fingerprint)
    }

}
