import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient

/// Replays the exact history pages a real host returned after 125 owner saves (Tests/Fixtures) through HostClient,
/// paging the way the Memory editor does, and checks which revisions the window keeps and which GETs it issues.
final class BotMemoryHistoryWindowTests: XCTestCase, @unchecked Sendable {
    private struct Capture: Decodable { let botId: String; let pages: [Page] }
    private struct Page: Decodable { let before: String?; let body: String }

    private func capture() throws -> Capture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/bot-memory-history-125.json")
        return try JSONDecoder().decode(Capture.self, from: Data(contentsOf: url))
    }

    func testRealPagesKeepTheNewestHundredAndStopAskingAtTheLimit() async throws {
        let recorded = try capture()
        XCTAssertEqual(recorded.pages.count, 7, "125 revisions in pages of 20")
        let transport = PagedTransport(bodies: recorded.pages.map { Data($0.body.utf8) })
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }

        var window = BotMemoryHistoryWindow()
        window.replace(with: try await client.getBotMemoryHistory(botID: recorded.botId))
        var olderReads = 0
        while window.canLoadOlder, let cursor = window.nextCursor {
            olderReads += 1
            XCTAssertLessThan(olderReads, 10, "paging must terminate")
            window.appendOlder(try await client.getBotMemoryHistory(botID: recorded.botId, before: cursor), requestedWith: cursor)
        }

        let revisions = window.items.map(\.revision)
        XCTAssertEqual(revisions.first, 125, "the head revision is never dropped")
        XCTAssertEqual(revisions, Array((26...125).reversed()), "the 100 newest, newest first, no gap")
        XCTAssertEqual(Set(revisions).count, revisions.count)
        XCTAssertTrue(window.reachedLimit)
        XCTAssertFalse(window.canLoadOlder)
        XCTAssertNil(window.nextCursor)

        let requests = await transport.requests()
        XCTAssertEqual(requests.count, 5, "no further GET once the window is full")
        XCTAssertEqual(requests.map { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "before" }?.value },
                       [nil, "r106", "r86", "r66", "r46"])
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" && $0.url?.path == "/v1/bots/\(recorded.botId)/documents/memory/history" })
    }

    func testRepeatedPageNeitherDuplicatesRevisionsNorFollowsAUsedCursor() async throws {
        let recorded = try capture()
        let first = try JSONDecoder().decode(BotMemoryHistory.self, from: Data(recorded.pages[0].body.utf8))
        let second = try JSONDecoder().decode(BotMemoryHistory.self, from: Data(recorded.pages[1].body.utf8))
        var window = BotMemoryHistoryWindow()
        window.replace(with: first)
        let cursor = try XCTUnwrap(window.nextCursor)
        window.appendOlder(second, requestedWith: cursor)
        XCTAssertEqual(window.items.count, 40)
        // A host answering the same cursor again (e.g. a stale reply) adds nothing and does not loop.
        let repeatedCursor = try XCTUnwrap(window.nextCursor)
        window.appendOlder(BotMemoryHistory(items: second.items, nextCursor: cursor), requestedWith: repeatedCursor)
        XCTAssertEqual(window.items.map(\.revision), Array((86...125).reversed()))
        XCTAssertNil(window.nextCursor, "a cursor already read is never requested again")
        XCTAssertFalse(window.reachedLimit)
        // Re-reading starts again from the newest page.
        window.replace(with: first)
        XCTAssertEqual(window.items.first?.revision, 125)
        XCTAssertEqual(window.nextCursor, "r106")
    }

    func testShortHistoryHasNoLimitNotice() throws {
        let recorded = try capture()
        let last = try JSONDecoder().decode(BotMemoryHistory.self, from: Data(recorded.pages[6].body.utf8))
        var window = BotMemoryHistoryWindow()
        window.replace(with: last)
        XCTAssertEqual(window.items.map(\.revision), [5, 4, 3, 2, 1])
        XCTAssertFalse(window.reachedLimit)
        XCTAssertFalse(window.canLoadOlder)
    }
}

private actor PagedTransport: HTTPTransport {
    private var bodies: [Data]
    private var captured: [URLRequest] = []
    init(bodies: [Data]) { self.bodies = bodies }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        captured.append(request)
        guard !bodies.isEmpty else { throw URLError(.badServerResponse) }
        return TransportResponse(statusCode: 200, data: bodies.removeFirst())
    }
    func requests() -> [URLRequest] { captured }
}
