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
    var dropBotA = false
    func dropA(_ v: Bool) { dropBotA = v }
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
        case "/v1/bots": value = ["items": (dropBotA ? ["b"] : ["a","b"]).map { ["id":$0,"name":$0,"profileId":"profile","engine":"claude","ownerId":"owner","createdAt":1] as [String:Any] }]
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

@MainActor final class ProbeNavTests: XCTestCase {
    private func model(_ transport: NavigationTransport) async -> DexterAppModel {
        let client = HostClient(baseURL:URL(string:"http://127.0.0.1:4317")!,transport:transport)
        let pairing = PairedHostOnboarding(journal:UnavailableClientClaimJournal(),storage:EphemeralPairedHostStateStorage(),identityStorage:{ _ in NavigationRefusingIdentity() })
        let model = DexterAppModel(client:client,storage:NavigationMemory(),pairing:pairing)
        await model.refresh()
        XCTAssertEqual(model.bots.count, 2)
        return model
    }
    func testProbeP1_iOSStyleOpenOfNonSelectedBotThreadSurvivesRefresh() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        XCTAssertEqual(model.selectedBotID, "a")
        let generation = await model.enterPresentedThread("u", for: "b")
        XCTAssertNotNil(generation)
        XCTAssertEqual(model.selectedBotID, "b")
        XCTAssertEqual(model.selectedThreadID, "u")
        await model.refresh()
        XCTAssertEqual(model.selectedBotID, "b")
        XCTAssertEqual(model.selectedThreadID, "u", "refresh must preserve the bot/thread pair opened by the iOS route")
    }
    func testProbeP5_selectedBotRemovedWithThreadOpenReselectsInSameRefresh() async throws {
        let transport = NavigationTransport(), model = await model(transport)
        await model.openThread("t")
        XCTAssertEqual(model.selectedThreadID, "t")
        await transport.dropA(true); await model.refresh()
        XCTAssertEqual(model.selectedBotID, "b", "stale removed bot must be replaced in the same refresh")
    }
}
