import Foundation
import XCTest
@testable import DexterHostClient

final class ThreadHistoryHostClientTests: XCTestCase, @unchecked Sendable {
    private func client(_ bodies: [String], status: Int = 200) -> (HostClient, HistoryTransport) {
        let transport = HistoryTransport(responses: bodies.map { .init(statusCode: status, data: Data($0.utf8)) })
        return (HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, transport: transport), transport)
    }
    private let summaryA = #"{"threadId":"thr_a","title":"Plano de viagem 🧳","preview":"Reservei o hotel","previewRole":"assistant","lastMessageHasImage":false,"messageCount":3,"lastMessageAt":40,"updatedAt":40}"#

    func testOneGetDecodesSummariesForPrivateThreadsOnly() async throws {
        let body = #"{"items":[{"id":"thr_a","botId":"bot","createdAt":10,"audience":"private","groupId":null,"groupConversationId":null},{"id":"thr_empty","botId":"bot","createdAt":20},{"id":"thr_team_x","botId":"bot","createdAt":30}],"summaries":["# + summaryA + #",{"threadId":"thr_empty","title":null,"preview":null,"previewRole":null,"lastMessageHasImage":false,"messageCount":0,"lastMessageAt":null,"updatedAt":20}]}"#
        let (client, transport) = client([body]); defer { client.close() }
        let history = try await client.listThreadHistory(botID: "bot")
        XCTAssertEqual(history.threads.map(\.id), ["thr_a", "thr_empty"], "Team lanes stay out of the private history")
        XCTAssertEqual(history.summary(for: "thr_a")?.title, "Plano de viagem 🧳")
        XCTAssertEqual(history.summary(for: "thr_a")?.previewRole, .assistant)
        XCTAssertEqual(history.summary(for: "thr_empty")?.messageCount, 0)
        XCTAssertTrue(history.summariesProvided); XCTAssertFalse(history.mayHaveOlderThreads)
        let calls = await transport.requests()
        XCTAssertEqual(calls.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }, ["GET /v1/bots/bot/threads"], "no per-thread GET")
    }

    func testLegacyHostWithoutSummariesIsHonest() async throws {
        let (client, _) = client([#"{"items":[{"id":"thr_a","botId":"bot","createdAt":10}]}"#]); defer { client.close() }
        let history = try await client.listThreadHistory(botID: "bot")
        XCTAssertEqual(history.threads.map(\.id), ["thr_a"]); XCTAssertTrue(history.summaries.isEmpty); XCTAssertFalse(history.summariesProvided)
    }

    func testHostWithoutListRouteFallsBackToLegacyDiscovery() async throws {
        let fallback = HistoryTransport(responses: [
            .init(statusCode: 404, data: Data(#"{"error":"not_found","message":"Route not found."}"#.utf8)),
            .init(statusCode: 200, data: Data(#"{"items":[{"cursor":1,"id":"evt","kind":"thread.created","botId":"bot","threadId":"thr_a","entityId":"thr_a","createdAt":1}],"nextCursor":1}"#.utf8)),
            .init(statusCode: 200, data: Data(#"{"id":"thr_a","botId":"bot","createdAt":1}"#.utf8)),
        ])
        let legacy = HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, transport: fallback); defer { legacy.close() }
        let history = try await legacy.listThreadHistory(botID: "bot")
        XCTAssertEqual(history.threads.map(\.id), ["thr_a"]); XCTAssertFalse(history.summariesProvided); XCTAssertTrue(history.summaries.isEmpty)
        let paths = await fallback.requests().map { $0.url?.path ?? "" }
        XCTAssertEqual(paths, ["/v1/bots/bot/threads", "/v1/events", "/v1/threads/thr_a"])
    }

    func testCrossBotOrForgedSummariesAreContractMismatch() async throws {
        let cases = [
            #"{"items":[{"id":"thr_a","botId":"other","createdAt":10}],"summaries":[]}"#,
            #"{"items":[{"id":"thr_b","botId":"bot","createdAt":10}],"summaries":["# + summaryA + #"]}"#,
            #"{"items":[{"id":"thr_a","botId":"bot","createdAt":10}],"summaries":["# + summaryA + "," + summaryA + #"]}"#,
            #"{"items":[{"id":"thr_a","botId":"bot","createdAt":10}],"summaries":[{"threadId":"thr_a","title":"Invented","preview":null,"previewRole":null,"lastMessageHasImage":false,"messageCount":0,"lastMessageAt":null,"updatedAt":10}]}"#,
            #"{"items":[{"id":"thr_a","botId":"bot","createdAt":10}],"summaries":[{"threadId":"thr_a","title":"two\nlines","preview":null,"previewRole":null,"lastMessageHasImage":false,"messageCount":1,"lastMessageAt":11,"updatedAt":11}]}"#,
            #"{"items":[{"id":"thr_a","botId":"bot","createdAt":10}],"summaries":[{"threadId":"thr_a","title":null,"preview":"x","previewRole":null,"lastMessageHasImage":false,"messageCount":1,"lastMessageAt":11,"updatedAt":11}]}"#,
            #"{"items":[{"id":"thr_a","botId":"bot","createdAt":10}],"summaries":[{"threadId":"thr_a","title":null,"preview":null,"previewRole":null,"lastMessageHasImage":true,"messageCount":1,"lastMessageAt":11,"updatedAt":99}]}"#,
        ]
        for (index, body) in cases.enumerated() {
            let (client, _) = client([body]); defer { client.close() }
            if index < 3 {
                do { _ = try await client.listThreadHistory(botID: "bot"); XCTFail(body) }
                catch let error as HostClientError { XCTAssertEqual(error, .contractMismatch, body) }
            } else {
                let history = try await client.listThreadHistory(botID: "bot")
                XCTAssertEqual(history.threads.map(\.id), ["thr_a"], "display corruption does not remove a conversation")
                XCTAssertTrue(history.summaries.isEmpty, "invalid metadata is ignored, never shown")
            }
        }
    }

    func testCapIsReportedAndOversizedListRefused() async throws {
        let items = (0..<500).map { #"{"id":"thr_\#($0)","botId":"bot","createdAt":\#($0)}"# }.joined(separator: ",")
        let (client, _) = client([#"{"items":[\#(items)],"summaries":[]}"#, #"{"items":[\#(items),{"id":"thr_x","botId":"bot","createdAt":1}]}"#]); defer { client.close() }
        let history = try await client.listThreadHistory(botID: "bot")
        XCTAssertEqual(history.threads.count, 500); XCTAssertTrue(history.mayHaveOlderThreads)
        do { _ = try await client.listThreadHistory(botID: "bot"); XCTFail("501 items") }
        catch let error as HostClientError { XCTAssertEqual(error, .contractMismatch) }
    }

    func testTeamHistoryUsesTheSameOwnerLocalGet() async throws {
        let body = #"{"items":[{"id":"thr_team_a","botId":"coord","createdAt":10,"teamId":"team"}],"summaries":[{"threadId":"thr_team_a","title":"Pauta da equipe","preview":"Pauta da equipe","previewRole":"user","lastMessageHasImage":false,"messageCount":1,"lastMessageAt":12,"updatedAt":12}]}"#
        let (client, transport) = client([body]); defer { client.close() }
        let history = try await client.listTeamThreadHistory(teamID: "team")
        XCTAssertEqual(history.summary(for: "thr_team_a")?.title, "Pauta da equipe")
        let paths = await transport.requests().map { $0.url?.path }
        XCTAssertEqual(paths, ["/v1/teams/team/threads"])
        let remote = HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, accessPolicy: .unpairedHost, transport: transport)
        defer { remote.close() }
        do { _ = try await remote.listTeamThreadHistory(teamID: "team"); XCTFail("owner-local only") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
    }

    func testInvalidBotIDNeverDispatches() async throws {
        let (client, transport) = client([]); defer { client.close() }
        do { _ = try await client.listThreadHistory(botID: "../x"); XCTFail() }
        catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        let count = await transport.requests().count; XCTAssertEqual(count, 0)
    }
}

private actor HistoryTransport: HTTPTransport {
    private var responses: [TransportResponse]
    private var captured: [URLRequest] = []
    init(responses: [TransportResponse]) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        captured.append(request)
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }
    func requests() -> [URLRequest] { captured }
}
