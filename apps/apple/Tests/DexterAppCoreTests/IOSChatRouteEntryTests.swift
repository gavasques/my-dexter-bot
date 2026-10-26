import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
import DexterClientIdentity

private struct RouteRefusingIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.unavailable }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.unavailable }
}
@MainActor private final class RouteMemory: DexterAppStateStorage {
    var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
private struct RouteRequest: Sendable {
    let method: String
    let path: String
    let body: Data?
}
private actor RouteTransport: HTTPTransport {
    private var hostID = "route-host"
    private var actualBot = "b"
    private var missing = false
    private var heldPath: String?
    private var arrived = false
    private var held: CheckedContinuation<Void, Never>?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var requests: [RouteRequest] = []
    func changeHostIdentity() { hostID = "new-route-host" }
    func mismatch() { actualBot = "c" }
    func remove() { missing = true }
    func hold(_ path: String) { heldPath = path; arrived = false }
    func waitHeld() async {
        if arrived { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() { heldPath = nil; held?.resume(); held = nil }
    func recorded() -> [RouteRequest] { requests }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        requests.append(.init(method: method, path: path, body: request.httpBody))
        var status = 200
        let value: [String: Any]
        switch path {
        case "/health": value = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": hostID, "state": [:]]
        case "/v1/bots": value = ["items": ["a", "b", "c"].map { ["id": $0, "name": $0, "profileId": "profile", "engine": "claude", "ownerId": "owner", "createdAt": 1] as [String: Any] }]
        case "/v1/bots/a/threads": value = ["items": [["id": "t", "botId": "a", "createdAt": 1]]]
        case "/v1/bots/b/threads": value = ["items": [["id": "u", "botId": "b", "createdAt": 1]]]
        case "/v1/bots/c/threads": value = ["items": [["id": "v", "botId": "c", "createdAt": 1], ["id": "u", "botId": "c", "createdAt": 1]]]
        case "/v1/threads/u":
            status = missing ? 404 : 200
            value = missing ? ["error": "not_found"] : ["id": "u", "botId": actualBot, "createdAt": 1]
        case "/v1/threads/u/messages", "/v1/threads/v/messages":
            let thread = path.contains("/u/") ? "u" : "v"
            value = ["items": [["cursor": 1, "id": "message-" + thread, "threadId": thread, "clientMessageId": "input-" + thread, "role": "assistant", "content": "answer-" + thread, "createdAt": 1]], "nextCursor": 1]
        case "/v1/threads/u/turns" where method == "POST":
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            status = 201
            value = ["cursor": 1, "id": "route-turn", "threadId": "u", "botId": "b", "engine": "claude", "clientRequestId": body["clientRequestId"]!, "inputMessageId": "input", "outputMessageId": NSNull(), "state": "completed", "code": NSNull(), "outputChars": 0, "outputTruncated": false, "createdAt": 1, "startedAt": 1, "finishedAt": 2, "updatedAt": 2]
        default: value = ["items": [], "nextCursor": 0]
        }
        // Capture the old response before suspending. Cancellation deliberately cannot erase it;
        // the AppModel must reject it using its own host/navigation identity checks.
        let response = TransportResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: value))
        if path == heldPath {
            await withCheckedContinuation { continuation in
                held = continuation; arrived = true
                let pending = waiters; waiters = []; pending.forEach { $0.resume() }
            }
        }
        return response
    }
}

@MainActor final class IOSChatRouteEntryTests: XCTestCase {
    private func ready(_ transport: RouteTransport) async -> DexterAppModel {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport)
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in RouteRefusingIdentity() })
        let model = DexterAppModel(client: client, storage: RouteMemory(), pairing: pairing)
        await model.refresh()
        XCTAssertTrue(model.isOnline)
        XCTAssertEqual(model.selectedBotID, "a")
        return model
    }
    private func noForeignReadsOrWrites(_ transport: RouteTransport) async {
        let requests = await transport.recorded()
        XCTAssertFalse(requests.contains { $0.path == "/v1/threads/u/messages" })
        XCTAssertFalse(requests.contains { $0.method == "POST" })
    }
    func testRouteBotBSurvivesRefreshAndSendsOnlyCorrelatedTurn() async throws {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        let generation = await model.enterPresentedThread("u", for: "b")
        XCTAssertNotNil(generation)
        XCTAssertEqual(model.selectedBotID, "b")
        XCTAssertEqual(model.presentedThreadID, "u")
        XCTAssertEqual(model.messages.map(\.threadId), ["u"])
        await model.refresh()
        XCTAssertEqual(model.selectedBotID, "b")
        XCTAssertEqual(model.presentedThreadID, "u")
        let accepted = await model.submit("exact route body", expectedThreadID: "u")
        XCTAssertTrue(accepted)
        let requests = await transport.recorded()
        let posts = requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts.first?.path, "/v1/threads/u/turns")
        let body = try XCTUnwrap(posts.first?.body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["content"] as? String, "exact route body")
        XCTAssertEqual(object["clientRequestId"] as? String, model.currentTurn?.clientRequestId)
        let reads = requests.filter { $0.method == "GET" }.map(\.path)
        XCTAssertLessThan(try XCTUnwrap(reads.firstIndex(of: "/v1/threads/u")), try XCTUnwrap(reads.firstIndex(of: "/v1/threads/u/messages")))
    }
    func testFreshMismatchedBotCannotUseCachedRowOrLoadOtherBot() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        XCTAssertTrue(model.threads(for: "b").contains { $0.id == "u" })
        await transport.mismatch()
        let result = await model.enterPresentedThread("u", for: "b")
        XCTAssertNil(result)
        XCTAssertEqual(model.selectedBotID, "a")
        XCTAssertNil(model.presentedThreadID)
        await noForeignReadsOrWrites(transport)
        let accepted = await model.submit("must not cross bot", expectedThreadID: "u")
        XCTAssertFalse(accepted)
    }
    func testFresh404CannotSelectOrLoadStaleRoute() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        await transport.remove()
        let result = await model.enterPresentedThread("u", for: "b")
        XCTAssertNil(result)
        XCTAssertEqual(model.selectedBotID, "a")
        XCTAssertNil(model.presentedThreadID)
        await noForeignReadsOrWrites(transport)
    }
    func testDelayedOldAddressCannotSelectOrLoad() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        await transport.hold("/v1/threads/u")
        let opening = Task { await model.enterPresentedThread("u", for: "b") }
        await transport.waitHeld()
        model.hostAddress = "http://127.0.0.1:4318"
        await transport.release()
        let result = await opening.value
        XCTAssertNil(result)
        XCTAssertEqual(model.selectedBotID, "a")
        XCTAssertNil(model.presentedThreadID)
        await noForeignReadsOrWrites(transport)
    }
    func testSameAddressNewHostIdentityRejectsOldReply() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        await transport.hold("/v1/threads/u")
        let opening = Task { await model.enterPresentedThread("u", for: "b") }
        await transport.waitHeld()
        let oldScope = model.nativeComposerScope
        await transport.changeHostIdentity()
        await model.refresh()
        XCTAssertNotEqual(model.nativeComposerScope, oldScope)
        let newHostSelection = model.presentedThreadID
        let newHostGeneration = model.threadPresentationGeneration
        await transport.release()
        let result = await opening.value
        XCTAssertNil(result)
        XCTAssertEqual(model.selectedBotID, "a")
        XCTAssertEqual(model.presentedThreadID, newHostSelection)
        XCTAssertEqual(model.threadPresentationGeneration, newHostGeneration)
        XCTAssertFalse(model.messages.contains { $0.threadId == "u" })
        await noForeignReadsOrWrites(transport)
    }
    func testNavigationChangeDuringCanonicalReadKeepsNewSelection() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        await transport.hold("/v1/threads/u")
        let opening = Task { await model.enterPresentedThread("u", for: "b") }
        await transport.waitHeld()
        model.selectBot(id: "c")
        await transport.release()
        let result = await opening.value
        XCTAssertNil(result)
        XCTAssertEqual(model.selectedBotID, "c")
        XCTAssertNil(model.presentedThreadID)
        await noForeignReadsOrWrites(transport)
    }
    func testCancelledEntryCannotSelectOrLoadDespiteLateReply() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        await transport.hold("/v1/threads/u")
        let opening = Task { await model.enterPresentedThread("u", for: "b") }
        await transport.waitHeld()
        opening.cancel()
        await transport.release()
        let result = await opening.value
        XCTAssertNil(result)
        XCTAssertEqual(model.selectedBotID, "a")
        XCTAssertNil(model.presentedThreadID)
        await noForeignReadsOrWrites(transport)
    }
    func testCancelledOwnedLoadClosesItsPresentationWithoutProjectingReply() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        await transport.hold("/v1/threads/u/messages")
        let opening = Task { await model.enterPresentedThread("u", for: "b") }
        await transport.waitHeld()
        XCTAssertEqual(model.selectedBotID, "b")
        XCTAssertEqual(model.presentedThreadID, "u")
        opening.cancel()
        await transport.release()
        let result = await opening.value
        XCTAssertNil(result)
        XCTAssertNil(model.presentedThreadID)
        XCTAssertTrue(model.messages.isEmpty)
        let requests = await transport.recorded()
        XCTAssertFalse(requests.contains { $0.method == "POST" })
    }
    func testForeignNavigationDuringLoadIsNotClosedOrReplaced() async {
        let transport = RouteTransport(), model = await ready(transport)
        defer { model.useFixture() }
        await transport.hold("/v1/threads/u/messages")
        let opening = Task { await model.enterPresentedThread("u", for: "b") }
        await transport.waitHeld()
        XCTAssertEqual(model.selectedBotID, "b")
        model.selectBot(id: "c")
        let generation = model.presentThread("v", for: "c")
        XCTAssertNotNil(generation)
        await model.loadPresentedThread("v", generation: generation!)
        await transport.release()
        let result = await opening.value
        XCTAssertNil(result)
        XCTAssertEqual(model.selectedBotID, "c")
        XCTAssertEqual(model.presentedThreadID, "v")
        XCTAssertEqual(model.messages.map(\.threadId), ["v"])
        XCTAssertEqual(model.messages.map(\.content), ["answer-v"])
        let accepted = await model.submit("stale u gesture", expectedThreadID: "u")
        XCTAssertFalse(accepted)
        let requests = await transport.recorded()
        XCTAssertFalse(requests.contains { $0.method == "POST" })
    }
    func testExplicitDemoConversationOpensThroughPhoneRouteWithoutHostReads() async {
        let transport = RouteTransport(), model = await ready(transport)
        model.useFixture()
        let before = await transport.recorded().count
        let result = await model.enterPresentedThread("fixture-thread", for: "fixture-bot")
        XCTAssertNotNil(result)
        XCTAssertEqual(model.presentedThreadID, "fixture-thread")
        XCTAssertEqual(model.messages.map(\.threadId), ["fixture-thread", "fixture-thread"])
        let requests = await transport.recorded()
        XCTAssertEqual(requests.count, before)
        let invalid = await model.enterPresentedThread("u", for: "b")
        XCTAssertNil(invalid)
        XCTAssertEqual(model.presentedThreadID, "fixture-thread")
        XCTAssertFalse(model.canUseHost)
    }
    func testFreshAndLegacyAutomaticDemoPhoneLaunchRequireRealPairing() async {
        let storage = RouteMemory()
        func phone() -> DexterAppModel {
            let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in RouteRefusingIdentity() })
            return DexterAppModel(storage: storage, pairing: pairing, platform: .iPhone)
        }
        let first = phone()
        XCTAssertFalse(first.isFixture); XCTAssertFalse(first.canUseHost); XCTAssertTrue(first.bots.isEmpty)
        XCTAssertEqual(first.hostAddress, "")
        await first.restorePairedHostAtLaunch()
        XCTAssertFalse(first.isOnline); XCTAssertTrue(first.bots.isEmpty)
        first.useFixture() // Explicit developer action still works, while preserving the legacy stored fixture shape.
        XCTAssertTrue(first.isFixture); XCTAssertFalse(first.bots.isEmpty)
        let reopened = phone()
        XCTAssertFalse(reopened.isFixture); XCTAssertFalse(reopened.canUseHost); XCTAssertTrue(reopened.bots.isEmpty)
    }
}
