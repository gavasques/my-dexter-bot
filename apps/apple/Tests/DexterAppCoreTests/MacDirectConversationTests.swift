import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
import DexterClientIdentity

private struct DirectRefusingIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.unavailable }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.unavailable }
}
@MainActor private final class DirectMemory: DexterAppStateStorage {
    var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}
/// In-memory host: thread.created events per bot, non-idempotent POST create, holds keyed by "METHOD path".
private actor DirectTransport: HTTPTransport {
    var threads: [(id: String, bot: String, createdAt: Int64)]
    var failEvents = false
    var heldKey: String?
    var pending: CheckedContinuation<Void, Never>?
    var arrival: [CheckedContinuation<Void, Never>] = []
    var arrived = false
    var requests: [String] = []
    init(_ threads: [(id: String, bot: String, createdAt: Int64)] = []) { self.threads = threads }
    func hold(_ key: String) { heldKey = key; arrived = false }
    func waitHeld() async { if arrived { return }; await withCheckedContinuation { arrival.append($0) } }
    func release() { heldKey = nil; pending?.resume(); pending = nil }
    func failList(_ value: Bool) { failEvents = value }
    func recorded() -> [String] { requests }
    func posts() -> Int { requests.filter { $0.hasPrefix("POST") }.count }
    func lists() -> Int { requests.filter { $0 == "GET /v1/events" }.count }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, key = (request.httpMethod ?? "GET") + " " + path
        requests.append(key)
        if key == heldKey {
            await withCheckedContinuation { pending = $0; arrived = true; let a = arrival; arrival = []; a.forEach { $0.resume() } }
        }
        let value: Any
        switch key {
        case "GET /health": value = ["protocolVersion":1,"mode":"local-development","engineRouting":"synthetic","remotePairing":"not_implemented","hostId":"own-host","state":[:]]
        case "GET /v1/bots": value = ["items": ["a","b"].map { ["id":$0,"name":$0,"profileId":"profile","engine":"claude","ownerId":"owner","createdAt":1] as [String:Any] }]
        case "GET /v1/events":
            if failEvents { return .init(statusCode:500,data:Data("{}".utf8)) }
            value = ["items": threads.enumerated().map { i, t in ["id":"event-"+t.id,"cursor":i+1,"kind":"thread.created","botId":t.bot,"entityId":t.id,"createdAt":t.createdAt] as [String:Any] },"nextCursor":threads.count]
        case let k where k.hasPrefix("GET /v1/threads/") && path.split(separator:"/").count == 3:
            let id = String(path.dropFirst("/v1/threads/".count))
            guard let t = threads.first(where: { $0.id == id }) else { return .init(statusCode:404,data:Data("{}".utf8)) }
            value = ["id":t.id,"botId":t.bot,"createdAt":t.createdAt]
        case let k where k.hasPrefix("POST /v1/bots/") && k.hasSuffix("/threads"):
            let bot = path.split(separator:"/")[2]
            let created = (id:"new-\(threads.count + 1)", bot:String(bot), createdAt:Int64(100 + threads.count))
            threads.append(created)
            value = ["id":created.id,"botId":created.bot,"createdAt":created.createdAt]
        default: value = ["items":[],"nextCursor":0]
        }
        return .init(statusCode:200,data:try JSONSerialization.data(withJSONObject:value))
    }
}

@MainActor final class MacDirectConversationTests: XCTestCase {
    private func model(_ transport: DirectTransport) async -> DexterAppModel {
        let client = HostClient(baseURL:URL(string:"http://127.0.0.1:4317")!,transport:transport)
        let pairing = PairedHostOnboarding(journal:UnavailableClientClaimJournal(),storage:EphemeralPairedHostStateStorage(),identityStorage:{ _ in DirectRefusingIdentity() })
        let model = DexterAppModel(client:client,storage:DirectMemory(),pairing:pairing)
        await model.refresh()
        XCTAssertEqual(model.bots.count, 2, model.errorMessage ?? "missing bots")
        XCTAssertEqual(model.selectedBotID, "a")
        return model
    }

    func testExistingReopensMostRecentWithTieByIDAndNoPost() async {
        let transport = DirectTransport([("t1","a",1),("t2","a",5),("t3","a",5),("u","b",9)]), model = await model(transport)
        let opened = await model.openConversationForSelectedBot("a")
        XCTAssertTrue(opened); XCTAssertEqual(model.presentedThreadID, "t3")
        let generation = model.threadPresentationGeneration, before = await transport.recorded()
        let again = await model.openConversationForSelectedBot("a")
        let after = await transport.recorded()
        XCTAssertTrue(again); XCTAssertEqual(before, after, "same presented bot is a no-op")
        XCTAssertEqual(generation, model.threadPresentationGeneration)
        XCTAssertFalse(after.contains { $0.hasPrefix("POST") })
        let foreign = await model.openConversationForSelectedBot("b")
        XCTAssertFalse(foreign, "unselected bot is refused")
        XCTAssertEqual(model.presentedThreadID, "t3")
    }

    func testEmptyCreatesExactlyOnceUnderConcurrentOpeners() async {
        let transport = DirectTransport(), model = await model(transport)
        let listsBefore = await transport.lists()
        await transport.hold("POST /v1/bots/a/threads")
        let first = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld()
        let second = Task { await model.openConversationForSelectedBot("a") }
        await Task.yield()
        await transport.release()
        let results = [await first.value, await second.value]
        XCTAssertEqual(results, [true, true])
        let posts = await transport.posts()
        let lists = await transport.lists()
        XCTAssertEqual(posts, 1); XCTAssertEqual(lists - listsBefore, 1, "second opener joined the in-flight resolution")
        XCTAssertEqual(model.presentedThreadID, "new-1")
        XCTAssertTrue(model.messages.isEmpty, "messages are loaded by the chat view, not here")
        let reopen = await model.openConversationForSelectedBot("a")
        let postsAfter = await transport.posts()
        XCTAssertTrue(reopen); XCTAssertEqual(postsAfter, 1)
    }

    func testListFailureShowsErrorAndNeverCreates() async {
        let transport = DirectTransport(), model = await model(transport)
        await transport.failList(true)
        let opened = await model.openConversationForSelectedBot("a")
        let posts = await transport.posts()
        XCTAssertFalse(opened); XCTAssertEqual(posts, 0)
        XCTAssertNil(model.presentedThreadID); XCTAssertNotNil(model.errorMessage)
        await transport.failList(false)
        let retried = await model.openConversationForSelectedBot("a")
        let retriedPosts = await transport.posts()
        XCTAssertTrue(retried, "explicit retry re-reads the list"); XCTAssertEqual(retriedPosts, 1)
    }

    func testBotSwitchDuringListNeitherCreatesNorReselects() async {
        let transport = DirectTransport(), model = await model(transport)
        await transport.hold("GET /v1/events")
        let opening = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld(); model.selectBot(id:"b"); await transport.release()
        let opened = await opening.value
        let posts = await transport.posts()
        XCTAssertFalse(opened); XCTAssertEqual(posts, 0)
        XCTAssertEqual(model.selectedBotID, "b"); XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.errorMessage)
    }

    func testHostChangeDuringHeldCreateCannotPresent() async {
        let transport = DirectTransport(), model = await model(transport)
        await transport.hold("POST /v1/bots/a/threads")
        let opening = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld(); model.disconnectPairedHost(); await transport.release()
        let opened = await opening.value
        XCTAssertFalse(opened); XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.selectedThreadID)
        XCTAssertNil(model.errorMessage, "a stale ambiguous create is not reported against the new host")
    }

    func testABADuringHeldCreateDedupesAndLatestOpenerPresents() async {
        let transport = DirectTransport(), model = await model(transport)
        let listsBefore = await transport.lists()
        await transport.hold("POST /v1/bots/a/threads")
        let stale = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld()
        model.selectBot(id:"b"); model.selectBot(id:"a")
        let latest = Task { await model.openConversationForSelectedBot("a") }
        await Task.yield()
        await transport.release()
        _ = await stale.value; let latestResult = await latest.value
        let posts = await transport.posts()
        let lists = await transport.lists()
        XCTAssertTrue(latestResult); XCTAssertEqual(posts, 1); XCTAssertEqual(lists - listsBefore, 1)
        XCTAssertEqual(model.selectedBotID, "a"); XCTAssertEqual(model.presentedThreadID, "new-1")
    }

    func testCancellingEveryOpenerDuringHeldListNeverCreates() async {
        let transport = DirectTransport(), model = await model(transport)
        await transport.hold("GET /v1/events")
        let first = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld()
        let second = Task { await model.openConversationForSelectedBot("a") }
        await Task.yield()
        first.cancel(); second.cancel()
        await transport.release()
        let results = [await first.value, await second.value]
        let posts = await transport.posts()
        XCTAssertEqual(results, [false, false]); XCTAssertEqual(posts, 0)
        XCTAssertEqual(model.selectedBotID, "a"); XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.errorMessage)
    }

    func testBackDuringHeldListNeverCreates() async {
        let transport = DirectTransport(), model = await model(transport)
        await transport.hold("GET /v1/events")
        let opening = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld(); model.closeThreadPresentation(); await transport.release()
        let opened = await opening.value
        let posts = await transport.posts()
        XCTAssertFalse(opened); XCTAssertEqual(posts, 0)
        XCTAssertNil(model.presentedThreadID); XCTAssertNil(model.selectedThreadID)
    }

    func testABADuringHeldListWithoutNewOpenerNeverCreates() async {
        let transport = DirectTransport(), model = await model(transport)
        await transport.hold("GET /v1/events")
        let stale = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld(); model.selectBot(id:"b"); model.selectBot(id:"a"); await transport.release()
        let opened = await stale.value
        let posts = await transport.posts()
        XCTAssertFalse(opened); XCTAssertEqual(posts, 0); XCTAssertNil(model.presentedThreadID)
    }

    func testABADuringHeldListWithNewOpenerCreatesOnceForLatestIntent() async {
        let transport = DirectTransport(), model = await model(transport)
        let listsBefore = await transport.lists()
        await transport.hold("GET /v1/events")
        let stale = Task { await model.openConversationForSelectedBot("a") }
        await transport.waitHeld()
        model.selectBot(id:"b"); model.selectBot(id:"a")
        let latest = Task { await model.openConversationForSelectedBot("a") }
        await Task.yield()
        await transport.release()
        _ = await stale.value; let latestResult = await latest.value
        let posts = await transport.posts()
        let lists = await transport.lists()
        XCTAssertTrue(latestResult); XCTAssertEqual(posts, 1); XCTAssertEqual(lists - listsBefore, 1)
        XCTAssertEqual(model.selectedBotID, "a"); XCTAssertEqual(model.presentedThreadID, "new-1")
    }

    func testFixturePresentsExistingWithoutRequests() async {
        let transport = DirectTransport(), model = await model(transport)
        model.useFixture()
        let before = await transport.recorded()
        let opened = await model.openConversationForSelectedBot("fixture-bot")
        let after = await transport.recorded()
        XCTAssertTrue(opened); XCTAssertEqual(model.presentedThreadID, "fixture-thread"); XCTAssertEqual(before, after)
    }
}
