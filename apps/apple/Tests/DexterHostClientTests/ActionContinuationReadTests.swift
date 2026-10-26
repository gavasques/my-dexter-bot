import Foundation
import XCTest
import DexterHostClient

@MainActor final class ActionContinuationReadTests: XCTestCase {
    func testRealHostProgressAndNullOriginAreGETOnlyWithNoImplicitResume() async throws {
        let progress: [String: Any] = ["originTurnId": "origin", "deliveredToEngine": false,
            "responseTurnId": "response", "responseState": "queued", "originValid": true, "resultBodyAvailable": true]
        let transport = ContinuationContractTransport(responses: [
            .init(statusCode: 200, data: try data(["continuation": progress])),
            .init(statusCode: 200, data: try data(["continuation": NSNull()])),
        ])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49191")!, transport: transport)
        let decoded = try await client.actionContinuation(actionID: "action-with-origin")
        XCTAssertEqual(decoded?.originTurnId, "origin")
        XCTAssertEqual(decoded?.responseTurnId, "response")
        XCTAssertEqual(decoded?.responseState, .queued)
        XCTAssertEqual(decoded?.deliveredToEngine, false)
        let noOrigin = try await client.actionContinuation(actionID: "action-without-origin")
        XCTAssertNil(noOrigin)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.map { $0.httpMethod }, ["GET", "GET"])
        XCTAssertEqual(requests.map { $0.url!.path }, ["/v1/actions/action-with-origin/continuation", "/v1/actions/action-without-origin/continuation"])
        XCTAssertTrue(requests.allSatisfy { $0.httpBody == nil && $0.timeoutInterval == 15 })
    }

    func testInconsistentProgressAndPermissionRefusalFailClosedWithoutFallbackMutation() async throws {
        let malformed: [String: Any] = ["originTurnId": "origin", "deliveredToEngine": false,
            "responseTurnId": NSNull(), "responseState": "queued", "originValid": true, "resultBodyAvailable": false]
        let transport = ContinuationContractTransport(responses: [
            .init(statusCode: 200, data: try data(["continuation": malformed])),
            .init(statusCode: 403, data: Data("{}".utf8)),
        ])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49191")!, transport: transport)
        do { _ = try await client.actionContinuation(actionID: "action"); XCTFail("Inconsistent response turn") }
        catch let failure as HostClientError { XCTAssertEqual(failure, .contractMismatch) }
        do { _ = try await client.actionContinuation(actionID: "action"); XCTFail("Forbidden") }
        catch let failure as HostClientError { XCTAssertEqual(failure, .forbidden) }
        let requests = await transport.recorded()
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "GET" })
    }

    private func data(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object) }
}

private actor ContinuationContractTransport: HTTPTransport {
    private var responses: [TransportResponse]
    private var requests: [URLRequest] = []
    init(responses: [TransportResponse]) { self.responses = responses }
    func recorded() -> [URLRequest] { requests }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw HostClientError.offline }
        return responses.removeFirst()
    }
}
