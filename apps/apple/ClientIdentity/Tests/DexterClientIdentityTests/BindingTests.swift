import XCTest
import Foundation
@testable import DexterClientIdentity
@MainActor final class BindingTests: XCTestCase {
    func testApprovedBindingRejectsEveryConfusedAuthorityAndPrivilegeField() throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:"host_fixture",offerID:"offer",role:.clientIOS,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let good: [String:Any] = ["protocol":"dexter-app-client-v1","status":"approved","deviceId":"device","installationId":"host_fixture","ownerId":"owner","role":"client-ios","scopes":["chat.read"],"pinGeneration":1,"bindingRevision":1]
        let binding = try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:good)
        XCTAssertEqual(binding.scopes,[.chatRead]); XCTAssertEqual(binding.installationID,"host_fixture")
        for (key,value) in [("protocol","agent-v1" as Any),("status","pending"),("installationId","foreign"),("role","client-mac"),("role","agent-mac"),("ownerId",NSNull()),("deviceId","../device"),("scopes",["chat.read","chat.read"]),("scopes",["mac.file.append"]),("pinGeneration",0),("bindingRevision",true),("capabilities",["mac.cua"])] {
            var bad = good; bad[key] = value; XCTAssertThrowsError(try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:bad),key)
        }
        let foreignScope = try ClientIdentityScope(installationID:"other",localBindingID:scope.localBindingID,role:.clientIOS,hostFingerprint:fixture.fingerprint)
        XCTAssertThrowsError(try PairedHostBinding(bundle:bundle,scope:foreignScope,identity:identity,claimID:"claim",value:good))
        let macScope = try ClientIdentityScope(installationID:scope.installationID,localBindingID:scope.localBindingID,role:.clientMac,hostFingerprint:fixture.fingerprint)
        XCTAssertThrowsError(try ClientPairingSession(bundle:bundle,scope:macScope,identity:identity,journal:TestJournal()))
        var noScopes = good; noScopes["scopes"] = [String](); let empty = try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:noScopes)
        XCTAssertTrue(empty.scopes.isEmpty)
    }
    func testScopeAndPairingRestrictionsDenyBeforeNetwork() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:"host_fixture",offerID:"offer",role:.clientIOS,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let value: [String:Any] = ["protocol":"dexter-app-client-v1","status":"approved","deviceId":"device","installationId":"host_fixture","ownerId":"owner","role":"client-ios","scopes":[String](),"pinGeneration":1,"bindingRevision":1]
        let binding = try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:value)
        let paired = try NativeHostTransport(identity:identity,binding:binding), pending = NativeHostTransport(identity:identity,host:try fixture.host())
        do { _ = try await paired.send(ClientRequest(route:.bots(ClientListPage()))); XCTFail("empty scopes gained chat") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.forbidden) }
        do { _ = try await pending.send(ClientRequest(route:.health)); XCTFail("unapproved gained API") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.forbidden) }
        do { _ = try await paired.send(.json(route:.pairStatus,value:["claimId":"claim"])); XCTFail("paired reverted to claim") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.forbidden) }
        XCTAssertEqual(try fixture.requests(),0); await paired.close().wait(); await pending.close().wait()
    }
    func testStrictOriginAndBundleRejectBeforeStorageOrDNS() throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        for url in ["http://127.0.0.1","https://user@127.0.0.1","https://127.0.0.1/path","https://127.0.0.1?q=x","https://127.0.0.1#x","https://invalid..host","https://-invalid.test"] {
            XCTAssertThrowsError(try PinnedClientHost(url:URL(string:url)!,certificateDER:fixture.der,fingerprint:fixture.fingerprint))
        }
        XCTAssertThrowsError(try PinnedClientHost(url:fixture.url,certificateDER:fixture.der,fingerprint:String(repeating:"0",count:64)))
        XCTAssertThrowsError(try ClientPairingBundle(host:fixture.host(),installationID:"host",offerID:"offer",role:.clientIOS,expiresAt:Date().addingTimeInterval(-1),code:String(repeating:"x",count:32)))
    }
    func testFactoryConfusedScopeFailsBeforeLoadAndValidMissingNeverProvisions() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:"host_fixture",offerID:"offer",role:.clientIOS,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let storage = MemoryStorage(), wrongScope = try ClientIdentityScope(installationID:"foreign",localBindingID:String(repeating:"a",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint)
        do { _ = try await ClientConnectionFactory.pairing(bundle:bundle,lifecycle:ClientIdentityLifecycle(scope:wrongScope,storage:storage),journal:TestJournal()); XCTFail("scope accepted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        let before = await storage.counts(); XCTAssertEqual(before,[0,0])
        let correct = try ClientIdentityScope(installationID:"host_fixture",localBindingID:wrongScope.localBindingID,role:.clientIOS,hostFingerprint:fixture.fingerprint)
        do { _ = try await ClientConnectionFactory.pairing(bundle:bundle,lifecycle:ClientIdentityLifecycle(scope:correct,storage:storage),journal:TestJournal()); XCTFail("missing identity provisioned") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.missing) }
        let counts = await storage.counts(); XCTAssertEqual(counts,[1,0]); XCTAssertEqual(try fixture.requests(),0)
    }

    func testOriginAuthorityExactDefaultAndExplicitPortWithoutCallerHeaders() throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let origin = try PinnedClientHost(url:URL(string:"https://127.0.0.1")!,certificateDER:fixture.der,fingerprint:fixture.fingerprint)
        let request = try ClientRequest(route:.health), defaultBytes = ClientHTTPWire.requestBytes(request,host:origin)
        let defaultHeader = String(decoding:defaultBytes,as:UTF8.self)
        XCTAssertTrue(defaultHeader.contains("Host: 127.0.0.1\r\n")); XCTAssertFalse(defaultHeader.contains(":443\r\n"))
        let explicitHeader = String(decoding:ClientHTTPWire.requestBytes(request,host:try fixture.host()),as:UTF8.self)
        XCTAssertTrue(explicitHeader.contains("Host: 127.0.0.1:\(fixture.url.port!)\r\n"))
        for name in ["Authorization:","Origin:","X-Owner:","X-Device:","X-Forwarded-"] { XCTAssertFalse(defaultHeader.contains(name)) }
    }

}
