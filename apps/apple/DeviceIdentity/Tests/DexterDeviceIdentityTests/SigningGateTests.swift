import XCTest
import DexterKeychainRuntime
@testable import DexterDeviceIdentity

@MainActor final class SigningGateTests:XCTestCase {
    func testUnboundOrAdHocRuntimeRefusesLoadAndProvisionWithFixedCause() async throws {
        let scope=try IdentityScope(installationID:"owned-signing-gate-fixture",laboratoryID:String(repeating:"c",count:32))
        for identity in [RuntimeSigningIdentity(validityStatus:0,bundleIdentifier:nil,codeIdentifier:"cli",teamIdentifier:nil,applicationIdentifier:nil,accessGroups:[]),
                         RuntimeSigningIdentity(validityStatus:0,bundleIdentifier:"com.dexter.qa",codeIdentifier:"com.dexter.qa",teamIdentifier:nil,applicationIdentifier:"com.dexter.qa",accessGroups:["com.dexter.qa"])] {
            let store=KeychainIdentityStorage(scope:scope,runtimeIdentity:{identity})
            do{_=try await store.load(scope);XCTFail("no signing context must not be confused with missing identity")}catch{XCTAssertEqual(error as? IdentityFailure,.signingIdentityUnavailable)}
            do{_=try await store.provision(scope);XCTFail("ad-hoc local claims cannot provision production DP identity")}catch{XCTAssertEqual(error as? IdentityFailure,.signingIdentityUnavailable)}
        }
    }
}
