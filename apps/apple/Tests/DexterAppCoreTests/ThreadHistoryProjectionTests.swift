import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

final class ThreadHistoryProjectionTests: XCTestCase {
    private let threads = [
        HostThread(id: "old", botId: "bot", createdAt: 10),
        HostThread(id: "empty", botId: "bot", createdAt: 50),
        HostThread(id: "image", botId: "bot", createdAt: 20),
        HostThread(id: "unknown", botId: "bot", createdAt: 60),
    ]
    private let summaries: [String: HostThreadSummary] = [
        "old": .init(threadID: "old", title: "Orçamento da reforma", preview: "Enviei a planilha", previewRole: .assistant,
                     lastMessageHasImage: false, messageCount: 4, lastMessageAt: 90, updatedAt: 90),
        "empty": .init(threadID: "empty", title: nil, preview: nil, previewRole: nil, lastMessageHasImage: false,
                       messageCount: 0, lastMessageAt: nil, updatedAt: 50),
        "image": .init(threadID: "image", title: nil, preview: nil, previewRole: nil, lastMessageHasImage: true,
                       messageCount: 1, lastMessageAt: 70, updatedAt: 70),
    ]

    func testHistorySnapshotRetainsConversationCreatedWhileLoading() {
        let before = Array(threads.prefix(2))
        let created = threads[2]
        let merged = ThreadHistoryProjection.retainingNewThreads(snapshot: [before[0]], knownIDs: Set(before.map(\.id)), current: before + [created])
        XCTAssertEqual(merged.map(\.id), [before[0].id, created.id], "a new persisted conversation survives a stale GET, and omitted old rows stay omitted")
        let reread = ThreadHistoryProjection.retainingNewThreads(snapshot: merged, knownIDs: Set(before.map(\.id)), current: before + [created])
        XCTAssertEqual(reread.map(\.id), merged.map(\.id), "no duplicate when GET already includes it")
    }

    func testRowsUseOnlyHostFactsAndSortByRecentActivity() {
        let rows = ThreadHistoryProjection.rows(threads: threads, summaries: summaries)
        XCTAssertEqual(rows.map(\.id), ["old", "image", "unknown", "empty"])
        XCTAssertEqual(rows[0].title, .text("Orçamento da reforma"))
        XCTAssertEqual(rows[0].preview, .text("Enviei a planilha", fromBot: true, lastMessageHasImage: false))
        XCTAssertEqual(rows[0].activityAt, 90); XCTAssertTrue(rows[0].activityKnown); XCTAssertEqual(rows[0].messageCount, 4)
        XCTAssertEqual(rows[1].title, .untitled); XCTAssertEqual(rows[1].preview, .image)
        XCTAssertEqual(rows[2].title, .unavailable); XCTAssertEqual(rows[2].preview, .unavailable)
        XCTAssertFalse(rows[2].activityKnown); XCTAssertNil(rows[2].messageCount); XCTAssertEqual(rows[2].activityAt, 60)
        XCTAssertEqual(rows[3].title, .noMessages); XCTAssertEqual(rows[3].preview, .none); XCTAssertFalse(rows[3].activityKnown)
    }

    func testSearchIsCaseAndDiacriticInsensitiveAndNeverMatchesUnknownRows() {
        let rows = { (query: String) in ThreadHistoryProjection.rows(threads: self.threads, summaries: self.summaries, query: query, locale: Locale(identifier: "pt_BR")).map(\.id) }
        XCTAssertEqual(rows("orcamento"), ["old"])
        XCTAssertEqual(rows("  PLANILHA   reforma "), ["old"])
        XCTAssertEqual(rows("planilha viagem"), [])
        XCTAssertEqual(rows("unknown"), [], "ids and missing summaries are never searchable text")
        XCTAssertEqual(rows("   ").count, 4)
    }

    func testMismatchedSummaryIsIgnored() {
        let forged = ["old": HostThreadSummary(threadID: "other", title: "Leak", preview: nil, previewRole: nil,
                                               lastMessageHasImage: false, messageCount: 1, lastMessageAt: 11, updatedAt: 11)]
        let row = ThreadHistoryProjection.rows(threads: [threads[0]], summaries: forged)[0]
        XCTAssertEqual(row.title, .unavailable)
    }
}
