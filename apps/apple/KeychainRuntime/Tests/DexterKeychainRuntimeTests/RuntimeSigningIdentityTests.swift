import XCTest
@testable import DexterKeychainRuntime
final class RuntimeSigningIdentityTests:XCTestCase {
    private func identity(_ validity:Int32=0,bundle:String?="com.dexter.qa",code:String?="com.dexter.qa",team:String?="QAONLY1234",app:String?="QAONLY1234.com.dexter.qa",groups:[String]=[])->RuntimeSigningIdentity {
        // Pure public metadata fixture. QAONLY1234 is not emitted as an actual entitlement or signing identity.
        RuntimeSigningIdentity(validityStatus:validity,bundleIdentifier:bundle,codeIdentifier:code,teamIdentifier:team,applicationIdentifier:app,accessGroups:groups)
    }
    func testUnsignedAdHocAndLocalClaimsFailBeforeAnyKeychainQuery() {
        for value in [identity(-67062),identity(team:nil),identity(team:nil,app:"com.dexter.qa",groups:["com.dexter.qa"])] { XCTAssertThrowsError(try value.exactDataProtectionAccessGroup()) }
    }
    func testBoundBundleAndOwnCodeIdentifierRequired() {
        for value in [identity(bundle:nil),identity(code:"another.helper"),identity(app:nil),identity(app:"QAONLY1234.other.bundle")] { XCTAssertThrowsError(try value.exactDataProtectionAccessGroup()) }
    }
    func testExactAuthorizedGroupNoWildcardOrDuplicateFallback() throws {
        XCTAssertEqual(try identity().exactDataProtectionAccessGroup(),"QAONLY1234.com.dexter.qa")
        XCTAssertEqual(try identity(groups:["QAONLY1234.com.dexter.own"]).exactDataProtectionAccessGroup(),"QAONLY1234.com.dexter.own")
        for groups in [["*"],["QAONLY1234.*"],["QAONLY1234.bad group"],["QAONLY1234.same","QAONLY1234.same"]] { XCTAssertThrowsError(try identity(groups:groups).exactDataProtectionAccessGroup()) }
    }
}
