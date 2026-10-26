import Foundation
import XCTest
@testable import DexterHostClient
@testable import DexterClientIdentity

actor PairedSenderStub: PairedNativeSending {
    var replies: [ClientTransportResponse]
    var routes: [ClientRoute] = []
    init(_ values: [[String:Any]], status: Int = 200) { replies = values.map { .init(statusCode:status,data:try! JSONSerialization.data(withJSONObject:$0)) } }
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse { routes.append(request.route); guard !replies.isEmpty else { throw ClientIdentityFailure.unavailable }; return replies.removeFirst() }
    nonisolated func close() -> ClientTransportClose { ClientTransportClose(Task {}) }
    func count() -> Int { routes.count }
}
@MainActor final class PairedHTTPTransportTests: XCTestCase {
    func binding(_ fixture: IntegrationTLSFixture, _ identity: ClientNativeIdentity) throws -> PairedHostBinding {
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientMac,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"offer",role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:43))
        return try .init(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:["protocol":"dexter-app-client-v1","status":"approved","deviceId":"device","installationId":"host_fixture","ownerId":"owner","role":"client-mac","scopes":ClientScope.legacyPairing.map(\.rawValue).sorted(),"pinGeneration":1,"bindingRevision":1])
    }
    func testClosedRoutesOriginCredentialsAndPagesRejectBeforeNativeHandoff() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let binding = try binding(fixture,identity), stub = PairedSenderStub([]), adapter = PairedHTTPTransport(binding:binding,sender:stub)
        let invalid = ["/v1/devices/device/dispatch","/v1/jobs","/app-client/v1/pair/claim","/v1/bots?limit=101","/v1/events?after=abc","/v1/devices?after=../foreign","/v1/events?after=1&after=2","/v1/device-grants?botId=bot&ownerId=owner","/v1/threads/a/messages?principal=owner"]
        for path in invalid { do { _ = try await adapter.send(URLRequest(url:URL(string:fixture.url.absoluteString+path)!)); XCTFail(path) } catch { XCTAssertTrue(error is HostClientError) } }
        for header in ["Authorization","Origin","X-Owner","X-Device","Cookie","X-Forwarded-Host"] {
            var request = URLRequest(url:fixture.url.appendingPathComponent("health")); request.setValue("synthetic",forHTTPHeaderField:header)
            do { _ = try await adapter.send(request); XCTFail(header) } catch { XCTAssertEqual(error as? HostClientError,.invalidRequest) }
        }
        var foreign = URLRequest(url:URL(string:"https://localhost:\(fixture.url.port!)/health")!)
        do { _ = try await adapter.send(foreign); XCTFail("origin") } catch { XCTAssertEqual(error as? HostClientError,.invalidRequest) }
        foreign.url = fixture.url.appendingPathComponent("v1/devices/device"); foreign.httpMethod = "PATCH"; foreign.httpBody = Data(#"{"name":"Renamed","ownerId":"owner"}"#.utf8)
        do { _ = try await adapter.send(foreign); XCTFail("principal body") } catch { XCTAssertEqual(error as? HostClientError,.invalidRequest) }
        let count = await stub.count(); XCTAssertEqual(count,0); XCTAssertEqual(try fixture.requests(),0)
        let numeric = try PairedHTTPTransport.prepare(URLRequest(url:URL(string:fixture.url.absoluteString+"/v1/threads/thread/messages?after=17&limit=2")!),binding:binding)
        XCTAssertEqual(numeric.route.path,"/v1/threads/thread/messages?after=17&limit=2")
        await adapter.beginClose().value
    }
    func testEveryHealthAuthorityFieldMustMatchApprovedBinding() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }; let bound = try binding(fixture,identity)
        let good: [String:Any] = ["protocolVersion":1,"mode":"paired-client","remotePairing":"implemented","installationId":"host_fixture","client":["deviceId":"device","role":"client-mac","scopes":bound.scopes.map(\.rawValue),"pinGeneration":1,"bindingRevision":1]]
        try PairedHTTPTransport.validateBoundResponse(.init(statusCode:200,data:try JSONSerialization.data(withJSONObject:good)),route:.health,binding:bound)
        for (field,value) in [("deviceId","foreign" as Any),("role","agent-mac"),("scopes",["chat.read"]),("pinGeneration",2),("bindingRevision",2)] {
            var bad = good, client = good["client"] as! [String:Any]; client[field] = value; bad["client"] = client
            XCTAssertThrowsError(try PairedHTTPTransport.validateBoundResponse(.init(statusCode:200,data:try JSONSerialization.data(withJSONObject:bad)),route:.health,binding:bound),field)
        }
        var bad = good; bad["installationId"] = "foreign"; XCTAssertThrowsError(try PairedHTTPTransport.validateBoundResponse(.init(statusCode:200,data:try JSONSerialization.data(withJSONObject:bad)),route:.health,binding:bound))
    }
    func testUnknownMutationMalformedReceiptAndRetainedClientsNeverRetry() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }; let bound = try binding(fixture,identity)
        let stub = PairedSenderStub([["error":"authority_changed","effect":"unknown"]],status:403), adapter = PairedHTTPTransport(binding:bound,sender:stub)
        let client = HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(bound),transport:adapter), retained = client
        do { _ = try await client.renameDevice(id:"device",name:"Renamed"); XCTFail("unknown cleared") } catch { XCTAssertEqual(error as? HostClientError,.mutationOutcomeUnknown) }
        let count = await stub.count(); XCTAssertEqual(count,1)
        await client.close().value
        do { _ = try await retained.listDevices(); XCTFail("retained admitted") } catch { XCTAssertTrue(error is CancellationError) }
        let final = await stub.count(); XCTAssertEqual(final,1)
        let malformed = PairedSenderStub([[:]]), other = PairedHTTPTransport(binding:bound,sender:malformed), second = HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(bound),transport:other)
        do { _ = try await second.renameDevice(id:"device",name:"Renamed"); XCTFail("malformed ack deemed no effect") } catch { XCTAssertEqual(error as? HostClientError,.mutationOutcomeUnknown) }
        await second.close().value
    }
    func testIDPaginationPreservesCursorAndFailsClosedOnNoProgress() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }; let bound = try binding(fixture,identity)
        let stub = PairedSenderStub([["items":[],"nextCursor":"cursor"]]), adapter = PairedHTTPTransport(binding:bound,sender:stub), client = HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(bound),transport:adapter)
        do { _ = try await client.listDevices(); XCTFail("empty page progressed") } catch { XCTAssertEqual(error as? HostClientError,.contractMismatch) }; let count = await stub.count(); XCTAssertEqual(count,1); await client.close().value
    }
}

actor HeldPairedSender: PairedNativeSending {
    private var response: CheckedContinuation<ClientTransportResponse,Never>?
    private var arrived = false
    private var arrival: [CheckedContinuation<Void,Never>] = []
    nonisolated let closeHandle = ClientTransportClose(Task {})
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        await withCheckedContinuation { continuation in response = continuation; arrived = true; let ready = arrival; arrival = []; ready.forEach {$0.resume()} }
    }
    func waitForArrival() async { if arrived { return }; await withCheckedContinuation { arrival.append($0) } }
    func release() { response?.resume(returning:.init(statusCode:200,data:Data("{}".utf8))); response = nil }
    nonisolated func close() -> ClientTransportClose { closeHandle }
}
extension PairedHTTPTransportTests {
    func testCloseWaitsForAdapterCallbackDrainAndWriteRemainsUnknown() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }; let bound = try binding(fixture,identity), held = HeldPairedSender(), adapter = PairedHTTPTransport(binding:bound,sender:held)
        var request = URLRequest(url:fixture.url.appendingPathComponent("v1/devices/device")); request.httpMethod = "PATCH"; request.httpBody = Data(#"{"name":"Renamed"}"#.utf8)
        let inflight = Task { try await adapter.send(request) }; await held.waitForArrival()
        let closing = adapter.beginClose(), repeated = adapter.beginClose()
        let premature = expectation(description:"close resolved before adapter callback drained"); premature.isInverted = true
        let observer = Task { await closing.value; premature.fulfill() }
        await fulfillment(of:[premature],timeout:0.05)
        do { _ = try await adapter.send(URLRequest(url:fixture.url.appendingPathComponent("health"))); XCTFail("closed admitted") } catch { XCTAssertTrue(error is CancellationError) }
        await held.release()
        do { _ = try await inflight.value; XCTFail("write receipt delivered after close") } catch { XCTAssertEqual(error as? HostClientError,.mutationOutcomeUnknown) }
        await closing.value; await repeated.value; await observer.value
    }
}
extension PairedHTTPTransportTests {
    func testExactly26ClosedAppRoutesAndMutationBodiesPreserveCanonicalBytes() throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }; let bound = try binding(fixture,identity)
        let reads = ["/health","/v1/contracts","/v1/bots?after=bot&limit=2","/v1/bots/bot","/v1/threads/thread","/v1/threads/thread/messages?after=7&limit=2","/v1/threads/thread/turns?after=7&limit=2","/v1/turns/turn","/v1/events?after=7&limit=2","/v1/turns/turn/events?after=7&limit=2","/v1/actions?after=action&limit=2","/v1/actions/action","/v1/devices?after=device&limit=2","/v1/devices/device","/v1/device-grants?botId=bot"]
        let writes: [(String,String,[String:Any])] = [("POST","/v1/bots",["name":"Bot","profileId":"profile","engine":"codex"]),("POST","/v1/bots/bot/threads",[:]),("POST","/v1/threads/thread/messages",["clientMessageId":"message","content":"synthetic"]),("POST","/v1/threads/thread/turns",["clientRequestId":"request","content":"synthetic"]),("POST","/v1/turns/turn/cancel",[:]),("POST","/v1/threads/thread/resume-queued",[:]),("POST","/v1/actions/action/decisions",["decision":"allow","requestHash":String(repeating:"a",count:64)]),("PATCH","/v1/devices/device",["name":"Renamed"]),("POST","/v1/devices/device/revoke",[:]),("PUT","/v1/device-grants",["botId":"bot","tool":"mac.file.append","destination":"agent","policy":"ask","expiresAt":NSNull(),"expectedRevision":NSNull()]),("POST","/app-client/v1/presence",["state":"foreground"])]
        XCTAssertEqual(reads.count+writes.count,26)
        for path in reads { let prepared = try PairedHTTPTransport.prepare(URLRequest(url:URL(string:fixture.url.absoluteString+path)!),binding:bound); XCTAssertEqual(prepared.route.method,"GET"); XCTAssertEqual(prepared.route.path,path); XCTAssertTrue(prepared.body.isEmpty) }
        for (method,path,body) in writes {
            var request = URLRequest(url:URL(string:fixture.url.absoluteString+path)!); request.httpMethod = method; request.httpBody = try JSONSerialization.data(withJSONObject:body,options:.sortedKeys)
            let prepared = try PairedHTTPTransport.prepare(request,binding:bound); XCTAssertEqual(prepared.route.method,method); XCTAssertEqual(prepared.route.path,path); XCTAssertEqual(prepared.body,request.httpBody)
        }
        XCTAssertEqual(try fixture.requests(),0)
    }
}
extension PairedHTTPTransportTests {
    func testNumericCursorIsCanonicalAndEmptyPageCannotAdvance() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }; let bound = try binding(fixture,identity)
        let stub = PairedSenderStub([["items":[],"nextCursor":8],["items":[],"nextCursor":7]]), adapter = PairedHTTPTransport(binding:bound,sender:stub), client = HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(bound),transport:adapter)
        do { _ = try await client.listMessages(threadID:"thread",after:7,limit:2); XCTFail("empty page fabricated progress") } catch { XCTAssertEqual(error as? HostClientError,.contractMismatch) }
        let page = try await client.listMessages(threadID:"thread",after:7,limit:2); XCTAssertTrue(page.items.isEmpty); XCTAssertEqual(page.nextCursor,7)
        await client.close().value
    }
}
