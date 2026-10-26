import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity

@MainActor final class PairedAppStateMemory: DexterAppStateStorage {
    var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}
actor PairedModelHeldSender: PairedNativeSending {
    private var write: CheckedContinuation<ClientTransportResponse,Never>?
    private var requestID: String?
    private var waiters: [CheckedContinuation<Void,Never>] = []
    nonisolated let closing = ClientTransportClose(Task {})
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        switch request.route {
        case .turns,.messages: return try response(["items":[],"nextCursor":0])
        case .actions: return try response(["items":[],"nextCursor":NSNull()])
        case .startTurn:
            let body = try JSONSerialization.jsonObject(with:request.body) as! [String:Any]; requestID = body["clientRequestId"] as? String
            return await withCheckedContinuation { write = $0; let ready = waiters; waiters = []; ready.forEach {$0.resume()} }
        default: throw ClientIdentityFailure.unavailable
        }
    }
    func waitForWrite() async { if requestID != nil { return }; await withCheckedContinuation { waiters.append($0) } }
    func id() -> String? { requestID }
    func release() throws { write?.resume(returning:try response([:])); write = nil }
    func response(_ value: [String:Any]) throws -> ClientTransportResponse { .init(statusCode:200,data:try JSONSerialization.data(withJSONObject:value)) }
    nonisolated func close() -> ClientTransportClose { closing }
}
@MainActor final class PairedAppModelTests: XCTestCase {
    func testHostGenerationDetachPreservesUnknownRequestAndPreventsStaleDelivery() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientMac,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"offer",role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:43))
        let binding = try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:["protocol":"dexter-app-client-v1","status":"approved","deviceId":"device","installationId":"host_fixture","ownerId":"owner","role":"client-mac","scopes":ClientScope.legacyPairing.map(\.rawValue).sorted(),"pinGeneration":1,"bindingRevision":1])
        let sender = PairedModelHeldSender(), adapter = PairedHTTPTransport(binding:binding,sender:sender), client = HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(binding),transport:adapter)
        let pairStorage = PairMetadataMemory(), keys = PairIdentityMemory(), onboarding = PairedHostOnboarding(journal:pairStorage.journal,storage:pairStorage,identityStorage:{_ in keys}), model = DexterAppModel(client:client,storage:PairedAppStateMemory(),pairing:onboarding)
        XCTAssertTrue(model.canUseHost); await model.openThread("thread")
        let submit = Task { await model.submit("synthetic message") }; await sender.waitForWrite()
        let captured = await sender.id(); let requestID = try XCTUnwrap(captured)
        XCTAssertEqual(onboarding.pending(installation:"host_fixture",device:"device",thread:"thread")?.clientRequestID,requestID)
        model.disconnectPairedHost(); XCTAssertFalse(model.canUseHost)
        try await sender.release(); let accepted = await submit.value; XCTAssertFalse(accepted)
        XCTAssertNil(model.currentTurn); XCTAssertTrue(model.messages.isEmpty)
        XCTAssertEqual(onboarding.pending(installation:"host_fixture",device:"device",thread:"thread")?.clientRequestID,requestID)
        XCTAssertNil(onboarding.pending(installation:"foreign",device:"device",thread:"thread"))
        do { _ = try await client.startTurn(threadID:"thread",submission:.init(content:"synthetic",clientRequestId:requestID)); XCTFail("retained client re-admitted mutation") } catch { XCTAssertTrue(error is CancellationError) }
        await client.close().value; XCTAssertEqual(try fixture.requests(),0)
        let counts = await keys.counts(); XCTAssertEqual(counts,[0,0])
        let bytes = String(decoding:try XCTUnwrap(pairStorage.bytes),as:UTF8.self); XCTAssertFalse(bytes.contains("synthetic message")); XCTAssertFalse(bytes.contains(String(repeating:"x",count:43)))
    }
}

actor PairedDeviceWriteHeldSender: PairedNativeSending {
    let devices: Data, renamed: Data
    private var continuation: CheckedContinuation<ClientTransportResponse,Never>?
    private var arrived = false
    private var waiters: [CheckedContinuation<Void,Never>] = []
    nonisolated let closing = ClientTransportClose(Task {})
    init(devices: Data, renamed: Data) { self.devices = devices; self.renamed = renamed }
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        switch request.route {
        case .devices: return .init(statusCode:200,data:devices)
        case .renameDevice:
            return await withCheckedContinuation { continuation = $0; arrived = true; let pending = waiters; waiters = []; pending.forEach {$0.resume()} }
        default: throw ClientIdentityFailure.unavailable
        }
    }
    func waitForWrite() async { if arrived { return }; await withCheckedContinuation { waiters.append($0) } }
    func release() { continuation?.resume(returning:.init(statusCode:200,data:renamed)); continuation = nil }
    nonisolated func close() -> ClientTransportClose { closing }
}
extension PairedAppModelTests {
    func testSelfRevokeRespectsR4GlobalOtherDeviceWriteGuard() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientMac,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"offer",role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:43))
        let binding = try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:["protocol":"dexter-app-client-v1","status":"approved","deviceId":"device","installationId":"host_fixture","ownerId":"owner","role":"client-mac","scopes":ClientScope.legacyPairing.map(\.rawValue).sorted(),"pinGeneration":1,"bindingRevision":1])
        let original = DeviceView(id:"other",ownerId:"owner",name:"Original",platform:.macos,capabilities:[],lastSeenAt:1,revokedAt:nil,presence:.online,paired:true)
        let updated = DeviceView(id:"other",ownerId:"owner",name:"Renamed",platform:.macos,capabilities:[],lastSeenAt:1,revokedAt:nil,presence:.online,paired:true)
        let object = try JSONSerialization.jsonObject(with:JSONEncoder().encode(original))
        let sender = PairedDeviceWriteHeldSender(devices:try JSONSerialization.data(withJSONObject:["items":[object],"nextCursor":NSNull()]),renamed:try JSONEncoder().encode(updated))
        let client = HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(binding),transport:PairedHTTPTransport(binding:binding,sender:sender)), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in PairIdentityMemory()}), model = DexterAppModel(client:client,storage:PairedAppStateMemory(),pairing:onboarding)
        await model.refreshDevices(); XCTAssertEqual(model.devices.map(\.id),["other"])
        let write = Task { await model.renameDevice(id:"other",name:"Renamed") }; await sender.waitForWrite(); XCTAssertEqual(model.operatingDeviceIDs,["other"])
        await model.revokeThisClient(); XCTAssertTrue(model.canUseHost,"self revoke cannot overlap and disconnect another in-flight write")
        let rowRevoke = await model.revokeDevice(id:"device"); XCTAssertFalse(rowRevoke); XCTAssertTrue(model.canUseHost)
        XCTAssertEqual(model.operatingDeviceIDs,["other"]); await sender.release(); let renamed = await write.value; XCTAssertTrue(renamed); XCTAssertTrue(model.operatingDeviceIDs.isEmpty)
        model.disconnectPairedHost(); await client.close().value; XCTAssertEqual(try fixture.requests(),0)
    }
}
