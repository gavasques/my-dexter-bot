import XCTest
import Foundation
@testable import DexterClientIdentity

private struct FixtureInfo: Decodable { let port: Int, certificateDER: String, fingerprint: String, missingRejected: Int, requests: Int }
@MainActor final class ClientTLSFixture {
    let root: URL, process: Process, url: URL, der: Data, fingerprint: String
    let missingRejected: Int
    init(identity: ClientNativeIdentity, mode: String = "normal") throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath:node) else { throw ClientIdentityFailure.invalidInput }
        root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-client-tls-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        process = Process(); let pipe = Pipe(); process.executableURL = URL(fileURLWithPath:node)
        let script = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/tls-host.mjs")
        process.arguments = [script.path,root.path,identity.fingerprint,mode]; process.environment = [:]; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        do {
            try process.run(); var line = Data()
            while line.count < 32768 { guard let byte = try pipe.fileHandleForReading.read(upToCount:1), !byte.isEmpty else { throw ClientIdentityFailure.unavailable }; if byte.first == 10 { break }; line.append(byte) }
            let info = try JSONDecoder().decode(FixtureInfo.self,from:line); url = URL(string:"https://127.0.0.1:\(info.port)")!; der = Data(base64Encoded:info.certificateDER)!; fingerprint = info.fingerprint; missingRejected = info.missingRejected
            XCTAssertEqual(info.requests,0,"missing identity must send zero HTTP")
        } catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root); throw error }
    }
    func host() throws -> PinnedClientHost { try .init(url:url,certificateDER:der,fingerprint:fingerprint) }
    /// The fixture publishes counts by private-tmp + atomic rename, so one read is exact. Missing/corrupt files throw (never default to 0).
    func requests() throws -> Int { guard let count = Int(try String(contentsOf:root.appendingPathComponent("requests.txt"),encoding:.utf8)) else { throw ClientIdentityFailure.unavailable }; return count }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() }; XCTAssertFalse(process.isRunning,"owned fixture process remains alive"); print("DEXTER_FIXTURE_CLEANUP pid=\(process.processIdentifier) running=\(process.isRunning)"); try? FileManager.default.removeItem(at:root) }
}
@MainActor final class TransportTests: XCTestCase {
    func binding(_ fixture: ClientTLSFixture, _ identity: ClientNativeIdentity, role: ClientRole = .clientIOS) async throws -> PairedHostBinding {
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:role,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:"host_fixture",offerID:"offer_fixture",role:role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let session = try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:TestJournal())
        XCTAssertFalse(bundle.description.contains(String(repeating:"x",count:32)))
        let claim = try await session.begin(name:"Phone"); XCTAssertEqual(claim,"claim_fixture")
        let status = try await session.status(); guard case .approved(let binding) = status else { throw ClientIdentityFailure.conflict }
        await session.close().wait(); return binding
    }
    func testRealTLSApprovedBindingAndEveryTypedEndpointMethodFreshSessions() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        XCTAssertEqual(fixture.missingRejected,1)
        let binding = try await binding(fixture,identity), transport = try NativeHostTransport(identity:identity,binding:binding)
        XCTAssertEqual(binding.clientFingerprint,identity.fingerprint); XCTAssertEqual(binding.role,.clientIOS); XCTAssertEqual(binding.pinGeneration,1)
        let id = try ClientResourceID("fixture"), page = try ClientPage(), listPage = try ClientListPage()
        let reads: [ClientRoute] = [.health,.contracts,.bots(listPage),.bot(id),.thread(id),.messages(id,page),.turns(id,page),.turn(id),.events(page),.turnEvents(id,page),.actions(listPage),.action(id),.devices(listPage),.device(id),.grants(id)]
        var requests = reads.map { try! ClientRequest(route:$0) }
        requests += [try .json(route:.createBot,value:["name":"Bot","profileId":"profile","engine":"codex"]),try .json(route:.createThread(id),value:[:]),try .json(route:.appendMessage(id),value:["clientMessageId":"message","content":"synthetic"]),try .json(route:.startTurn(id),value:["clientRequestId":"turn","content":"synthetic"]),try .json(route:.cancelTurn(id),value:[:]),try .json(route:.resumeQueued(id),value:[:]),try .json(route:.decideAction(id),value:["decision":"allow","requestHash":String(repeating:"a",count:64)]),try .json(route:.renameDevice(id),value:["name":"Renamed"]),try .json(route:.revokeDevice(id),value:[:]),try .json(route:.putGrant,value:["botId":"bot","tool":"mac.file.append","destination":"agent","policy":"ask","expiresAt":NSNull(),"expectedRevision":NSNull()]),try .json(route:.presence,value:["state":"foreground"])]
        for request in requests {
            let response = try await transport.send(request,timeoutSeconds:3), value = try JSONSerialization.jsonObject(with:response.data) as! [String:Any]
            XCTAssertEqual(value["tls"] as? String,"TLSv1.3"); XCTAssertEqual(value["resumed"] as? Bool,false)
            XCTAssertEqual(value["method"] as? String,request.route.method); XCTAssertEqual(value["path"] as? String,request.route.path)
        }
        XCTAssertEqual(try fixture.requests(),requests.count+2)
        let a = transport.close(), b = transport.close(); XCTAssertTrue(a === b); await a.wait()
        do { _ = try await transport.send(ClientRequest(route:.health)); XCTFail("closed retained facade admitted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.closed) }
    }
    func testWrongPinSANExpiredAndWrongEKUFailBeforeHTTP() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture()
        for mode in ["wrong-san","expired","wrong-eku"] {
            let fixture = try ClientTLSFixture(identity:identity,mode:mode); defer { fixture.close() }
            do {
                let transport = NativeHostTransport(identity:identity,host:try fixture.host())
                _ = try await transport.send(.json(route:.pairStatus,value:["claimId":"claim"]),timeoutSeconds:3); XCTFail("unsafe certificate admitted: \(mode)")
            } catch { XCTAssertTrue(error is ClientIdentityFailure) }
            XCTAssertEqual(try fixture.requests(),0)
        }
        let fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let foreignFixture = try ClientTLSFixture(identity:identity); defer { foreignFixture.close() }
        let foreign = try PinnedClientHost(url:fixture.url,certificateDER:foreignFixture.der,fingerprint:foreignFixture.fingerprint)
        do { _ = try await NativeHostTransport(identity:identity,host:foreign).send(.json(route:.pairStatus,value:["claimId":"claim"]),timeoutSeconds:3); XCTFail("wrong exact pin accepted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.pinMismatch) }
        XCTAssertEqual(try fixture.requests(),0)
    }
    func testTLS12RedirectFramingAndResponseBoundsNeverRetry() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture()
        for mode in ["tls12","redirect","large","barelf"] {
            let fixture = try ClientTLSFixture(identity:identity,mode:mode); defer { fixture.close() }
            let transport = NativeHostTransport(identity:identity,host:try fixture.host())
            do { _ = try await transport.send(.json(route:.pairStatus,value:["claimId":"claim"]),timeoutSeconds:3); XCTFail("unsafe response accepted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,mode == "tls12" ? .unavailable : .protocolError) }
            XCTAssertEqual(try fixture.requests(),mode == "tls12" ? 0 : 1)
            await transport.close().wait()
        }
    }
    func testCancellationTimeoutCloseDrainAndNoLateDelivery() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity,mode:"delay"); defer { fixture.close() }
        let transport = NativeHostTransport(identity:identity,host:try fixture.host()), request = try ClientRequest.json(route:.pairClaim,value:["offerId":"offer","code":String(repeating:"x",count:32),"name":"Phone"])
        do { _ = try await transport.send(request,timeoutSeconds:0.5); XCTFail("timeout response") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        let task = Task { try await transport.send(request,timeoutSeconds:5) }
        while try fixture.requests() < 2 { try await Task.sleep(for:.milliseconds(10)) }
        let close = transport.close(); XCTAssertTrue(close === transport.close()); await close.wait()
        do { _ = try await task.value; XCTFail("late response escaped detach") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        do { _ = try await transport.send(request); XCTFail("reopened after close") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.closed) }
        try await Task.sleep(for:.milliseconds(1100)); XCTAssertEqual(try fixture.requests(),2)
        let fresh = NativeHostTransport(identity:identity,host:try fixture.host()), cancelled = Task { try await fresh.send(request) }; cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("precancel sent") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.cancelled) }
        await fresh.close().wait(); XCTAssertEqual(try fixture.requests(),2)
    }
    func testForeignApprovedMetadataCannotCreateBindingAndIdentitySwapDenied() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity,mode:"foreign-install"); defer { fixture.close() }
        do { _ = try await binding(fixture,identity); XCTFail("foreign installation binding") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.conflict) }
        let good = try ClientTLSFixture(identity:identity,mode:"client-mac"); defer { good.close() }
        let binding = try await binding(good,identity,role:.clientMac), other = try ClientNativeIdentity.ephemeralFixture()
        XCTAssertThrowsError(try NativeHostTransport(identity:other,binding:binding)); XCTAssertEqual(binding.role,.clientMac)
    }
    func testPendingReferenceRestoresSameIdentityOnlyAndNeedsPinnedApprovalAgain() async throws {
        let storage = MemoryStorage(), identity = try ClientNativeIdentity.ephemeralFixture()
        let fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"b",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint)
        await storage.install(scope,identity:identity)
        let lifecycle = ClientIdentityLifecycle(scope:scope,storage:storage)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:"host_fixture",offerID:"offer",role:.clientIOS,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let journal = TestJournal()
        let session = try await ClientConnectionFactory.pairing(bundle:bundle,lifecycle:lifecycle,journal:journal)
        _ = try await session.begin(name:"Phone"); let pending = try await session.pendingReference(); await session.close().wait()
        let recreated = ClientIdentityLifecycle(scope:scope,storage:storage), restored = try await ClientConnectionFactory.restore(pending:pending,lifecycle:recreated,journal:journal)
        guard case .approved(let binding) = try await restored.status() else { throw ClientIdentityFailure.conflict }
        XCTAssertEqual(binding.clientFingerprint,identity.fingerprint); XCTAssertEqual(binding.localBindingID,scope.localBindingID)
        let transport = try await ClientConnectionFactory.paired(binding:binding,lifecycle:recreated)
        _ = try await transport.send(ClientRequest(route:.health)); await transport.close().wait(); await restored.close().wait()
        let counts = await storage.counts(); XCTAssertEqual(counts,[3,0]); XCTAssertEqual(try fixture.requests(),3)
    }
    func testReadTimeoutAndCancellationRemainLocalWithoutClaimingRemoteMutation() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity,mode:"delay"); defer { fixture.close() }
        let transport = NativeHostTransport(identity:identity,host:try fixture.host()), request = try ClientRequest.json(route:.pairStatus,value:["claimId":"claim"])
        do { _ = try await transport.send(request,timeoutSeconds:0.5); XCTFail("read timeout leaked result") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.timeout) }
        let task = Task { try await transport.send(request,timeoutSeconds:5) }
        let baseline = try fixture.requests(); while try fixture.requests() <= baseline { try await Task.sleep(for:.milliseconds(10)) }
        task.cancel(); do { _ = try await task.value; XCTFail("read cancel leaked result") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.cancelled) }
        await transport.close().wait()
    }

    func testLostClaimAcknowledgementNeverRetriesOrCreatesAnotherLocalClaim() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity,mode:"delay"); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientIOS,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:"host_fixture",offerID:"offer",role:.clientIOS,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:32))
        let session = try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:TestJournal())
        for _ in 0..<2 {
            do { _ = try await session.begin(name:"Phone"); XCTFail("lost claim acknowledged or retried") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.outcomeUnknown) }
        }
        XCTAssertEqual(try fixture.requests(),1); await session.close().wait()
    }

    func testCanonicalBytesReachActualTLSFixtureOnce() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity,mode:"echo"); defer { fixture.close() }
        let transport = NativeHostTransport(identity:identity,host:try fixture.host())
        for input in [Data(#"{"claimId":"good_claim","claimId":"../../evil"}"#.utf8),Data("  { \"claimId\": \"good_claim\" }  ".utf8),"{\"claimId\":\"good_claim\"}".data(using:.utf16)!] {
            let request = try ClientRequest(route:.pairStatus,body:input), response = try await transport.send(request)
            let value = try JSONSerialization.jsonObject(with:response.data) as! [String:Any]
            XCTAssertEqual(value["utf8"] as? String,String(decoding:request.body,as:UTF8.self))
            XCTAssertEqual((value["body"] as? [String:String]),["claimId":"good_claim"])
            XCTAssertEqual(value["tls"] as? String,"TLSv1.3"); XCTAssertEqual(value["resumed"] as? Bool,false)
        }
        XCTAssertEqual(try fixture.requests(),3); await transport.close().wait()
    }

}
