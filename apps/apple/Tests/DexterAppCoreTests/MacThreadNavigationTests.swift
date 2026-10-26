import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
import DexterClientIdentity

private struct NavigationRefusingIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.unavailable }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.unavailable }
}
@MainActor private final class NavigationMemory: DexterAppStateStorage {
    var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}
private actor NavigationTransport: HTTPTransport {
    var dropped = false
    var running = false
    var heldPath: String?
    var pending: CheckedContinuation<Void, Never>?
    var arrival: [CheckedContinuation<Void, Never>] = []
    var arrived = false
    var requests: [String] = []
    func hold(_ path: String) { heldPath = path; arrived = false }
    func waitHeld() async { if arrived { return }; await withCheckedContinuation { arrival.append($0) } }
    func release() { heldPath = nil; pending?.resume(); pending = nil }
    func drop(_ value: Bool) { dropped = value }
    func run() { running = true }
    func recorded() -> [String] { requests }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path
        requests.append((request.httpMethod ?? "GET") + " " + path)
        if path == heldPath {
            await withCheckedContinuation { pending = $0; arrived = true; let a = arrival; arrival = []; a.forEach { $0.resume() } }
        }
        let value: [String: Any]
        switch path {
        case "/health": value = ["protocolVersion":1,"mode":"local-development","engineRouting":"synthetic","remotePairing":"not_implemented","hostId":"own-host","state":[:]]
        case "/v1/bots": value = ["items": ["a","b"].map { ["id":$0,"name":$0,"profileId":"profile","engine":"claude","ownerId":"owner","createdAt":1] as [String:Any] }]
        case "/v1/events": value = ["items": (dropped ? ["b"] : ["a","b"]).enumerated().map { i, bot in ["id":"event-"+bot,"cursor":i+1,"kind":"thread.created","botId":bot,"entityId":bot == "a" ? "t" : "u","createdAt":1] as [String:Any] },"nextCursor":dropped ? 1 : 2]
        case "/v1/threads/t": value = ["id":"t","botId":"a","createdAt":1]
        case "/v1/threads/u": value = ["id":"u","botId":"b","createdAt":1]
        case "/v1/bots/a/threads": value = ["items": dropped ? [] : [["id":"t","botId":"a","createdAt":1]]]
        case "/v1/bots/b/threads": value = ["items":[["id":"u","botId":"b","createdAt":1]]]
        case "/v1/threads/t/messages": value = ["items":[["cursor":1,"id":"m","threadId":"t","clientMessageId":"cm","role":"assistant","content":"late answer","createdAt":1]],"nextCursor":1]
        case "/v1/threads/t/turns": value = ["items": running ? [turn()] : [],"nextCursor":running ? 1 : 0]
        case "/v1/turns/r/events": value = ["items":[],"nextCursor":0]
        case "/v1/turns/r": value = turn()
        default: value = ["items":[],"nextCursor":0]
        }
        return .init(statusCode:200,data:try JSONSerialization.data(withJSONObject:value))
    }
    private func turn() -> [String: Any] {
        ["cursor":1,"id":"r","threadId":"t","botId":"a","engine":"claude","clientRequestId":"req","inputMessageId":"input","outputMessageId":NSNull(),"state":"running","code":NSNull(),"outputChars":0,"outputTruncated":false,"createdAt":1,"startedAt":1,"finishedAt":NSNull(),"updatedAt":1]
    }
}

@MainActor final class MacThreadNavigationTests: XCTestCase {
    private func model(_ transport: NavigationTransport) async -> DexterAppModel {
        let client = HostClient(baseURL:URL(string:"http://127.0.0.1:4317")!,transport:transport)
        let pairing = PairedHostOnboarding(journal:UnavailableClientClaimJournal(),storage:EphemeralPairedHostStateStorage(),identityStorage:{ _ in NavigationRefusingIdentity() })
        let model = DexterAppModel(client:client,storage:NavigationMemory(),pairing:pairing)
        await model.refresh()
        XCTAssertEqual(model.bots.count, 2, model.errorMessage ?? "missing bots")
        return model
    }
    func testBackFencesHeldMessageAndQueuedLoadWithoutRemoteCancel() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        let generation = try XCTUnwrap(model.presentThread("t",for:"a"))
        await transport.hold("/v1/threads/t/messages")
        let loading = Task { await model.loadPresentedThread("t",generation:generation) }
        await transport.waitHeld()
        model.closeThreadPresentation()
        XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.selectedThreadID)
        await transport.release(); await loading.value
        let before = await transport.recorded()
        await model.loadPresentedThread("t",generation:generation)
        let after = await transport.recorded()
        XCTAssertEqual(before,after); XCTAssertTrue(model.messages.isEmpty); XCTAssertNil(model.currentTurn)
        XCTAssertFalse(after.contains { $0.hasPrefix("POST") })
    }
    func testDroppedThreadDuringOpeningCannotReappearOrReplayOldToken() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        let generation = try XCTUnwrap(model.presentThread("t",for:"a"))
        await transport.hold("/v1/threads/t/messages")
        let loading = Task { await model.loadPresentedThread("t",generation:generation) }
        await transport.waitHeld(); await transport.drop(true); await model.refresh()
        XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.selectedThreadID)
        await transport.drop(false); await model.refresh()
        XCTAssertEqual(model.threads(for:"a").map(\.id),["t"]); XCTAssertNil(model.presentedThreadID)
        await transport.release(); await loading.value
        await model.loadPresentedThread("t",generation:generation)
        XCTAssertTrue(model.messages.isEmpty); XCTAssertNil(model.selectedThreadID)
        XCTAssertNotNil(model.presentThread("t",for:"a"))
    }
    func testBotChangeFencesHeldActionsAndRejectsForeignThread() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        XCTAssertNil(model.presentThread("u",for:"a"))
        let generation = try XCTUnwrap(model.presentThread("t",for:"a"))
        model.selectBot(id:"a"); XCTAssertEqual(model.presentedThreadID,"t","same-bot selection consistently keeps Chat")
        await transport.hold("/v1/actions")
        let loading = Task { await model.loadPresentedThread("t",generation:generation) }
        await transport.waitHeld(); model.selectBot(id:"b")
        await transport.release(); await loading.value
        XCTAssertNil(model.presentedThreadID); XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.presentThread("t",for:"a")); XCTAssertNotNil(model.presentThread("u",for:"b"))
    }
    func testHostDetachAndLateHealthCannotReselect() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        let generation = try XCTUnwrap(model.presentThread("t",for:"a"))
        await transport.hold("/health")
        let refresh = Task { await model.refresh() }; await transport.waitHeld()
        model.closeThreadPresentation(); await transport.release(); await refresh.value
        XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.selectedThreadID)
        XCTAssertNotNil(model.presentThread("t",for:"a"))
        await transport.hold("/v1/threads/t/messages")
        let load = Task { await model.loadPresentedThread("t",generation:model.threadPresentationGeneration) }
        await transport.waitHeld(); model.disconnectPairedHost(); await transport.release(); await load.value
        await model.loadPresentedThread("t",generation:generation)
        XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.selectedThreadID); XCTAssertTrue(model.messages.isEmpty)
    }
    func testBackStopsHeldRunningPollWithoutCancelMutation() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        await transport.run(); await transport.hold("/v1/turns/r/events")
        let generation = try XCTUnwrap(model.presentThread("t",for:"a"))
        await model.loadPresentedThread("t",generation:generation); await transport.waitHeld()
        XCTAssertEqual(model.currentTurn?.state,.running)
        model.closeThreadPresentation(); await transport.release()
        await Task.yield()
        XCTAssertNil(model.currentTurn); XCTAssertTrue(model.streamingText.isEmpty)
        let requests = await transport.recorded(); XCTAssertFalse(requests.contains { $0.hasPrefix("POST") })
    }
    func testFixtureBackReopenRestoresMessagesWithoutResurrectingOldSelection() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        model.useFixture(); XCTAssertNil(model.presentedThreadID)
        let old = try XCTUnwrap(model.presentThread("fixture-thread",for:"fixture-bot"))
        XCTAssertEqual(model.messages.count,2)
        model.closeThreadPresentation(); XCTAssertTrue(model.messages.isEmpty)
        await model.loadPresentedThread("fixture-thread",generation:old)
        XCTAssertNil(model.presentedThreadID)
        XCTAssertNotNil(model.presentThread("fixture-thread",for:"fixture-bot")); XCTAssertEqual(model.messages.count,2)
        XCTAssertNotEqual(old,model.threadPresentationGeneration)
    }
    func testProductionRowSelectionMovesClampsAndDoesNotActivateDroppedID() {
        var row = DexterThreadListSelection()
        row.move(1,in:["t","u"]); XCTAssertEqual(row.activation(in:["t","u"]),"t")
        row.move(1,in:["t","u"]); row.move(1,in:["t","u"]); XCTAssertEqual(row.selectedID,"u")
        XCTAssertNil(row.activation(in:["t"])); row.reconcile(in:["t"]); XCTAssertNil(row.selectedID)
        row.reconcile(in:["t","u"]); XCTAssertNil(row.selectedID,"drop/reappear never resurrects row intent")
        row.move(-1,in:["t","u"]); XCTAssertEqual(row.activation(in:["t","u"]),"u")
        row.move(-1,in:["t","u"]); XCTAssertEqual(row.selectedID,"t")
        row.move(1,in:[]); XCTAssertNil(row.selectedID)
    }
}
