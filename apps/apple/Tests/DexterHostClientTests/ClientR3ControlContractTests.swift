import Foundation
import XCTest
@testable import DexterHostClient

final class ClientR3ControlContractTests: XCTestCase {
    func testSparseDisabledAgendaHasUnknownCountersAndNoFabricatedFacts() async throws {
        let data = Data(#"{"hostId":"synthetic-r3","configured":false,"running":false}"#.utf8)
        let transport = R3ControlTransport(status: 200, reply: String(decoding: data, as: UTF8.self))
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49217")!, transport: transport)
        let status = try await client.automationStatus()
        XCTAssertFalse(status.configured); XCTAssertFalse(status.running)
        XCTAssertNil(status.admission); XCTAssertNil(status.inFlight); XCTAssertNil(status.lastOutcome)
        XCTAssertNil(status.completedTicks); XCTAssertNil(status.accepted); XCTAssertNil(status.replayed); XCTAssertNil(status.deferred)
        let reads = await transport.requests; XCTAssertEqual(reads.map { $0.httpMethod }, ["GET"])
        XCTAssertEqual(reads.first?.url?.path, "/v1/automations/status")
        for body in [#"{"configured":false,"running":false}"#, #"{"hostId":"synthetic-r3","running":false}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(AutomationStatus.self, from: Data(body.utf8)))
        }
    }
    func testResumeSendsOnlyExistingEmptySchemaAndNeverRetriesAmbiguousMutation() async throws {
        let transport = R3ControlTransport(status: 200, reply: #"{"resumed":1}"#)
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49217")!, transport: transport)
        let acknowledgment = try await client.resumeQueued(threadID: "thread-r3")
        XCTAssertEqual(acknowledgment.resumed, 1)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1); XCTAssertEqual(requests.first?.url?.path, "/v1/threads/thread-r3/resume-queued")
        XCTAssertEqual(requests.first?.httpMethod, "POST")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: try XCTUnwrap(requests.first?.httpBody)) as? [String: String], [:])
        for status in [500, 503] {
            let unavailable = R3ControlTransport(status: status, reply: #"{"error":"not_connected"}"#)
            let offlineClient = HostClient(baseURL: URL(string: "http://127.0.0.1:49217")!, transport: unavailable)
            do { _ = try await offlineClient.resumeQueued(threadID: "thread-r3"); XCTFail("Expected safe refusal/uncertainty") }
            catch { XCTAssertEqual(error as? HostClientError, status == 503 ? .notReady : .mutationOutcomeUnknown) }
            let count = await unavailable.requests.count; XCTAssertEqual(count, 1)
        }
    }
}
private actor R3ControlTransport: HTTPTransport {
    let status: Int; let reply: String
    private(set) var requests: [URLRequest] = []
    init(status: Int, reply: String) { self.status = status; self.reply = reply }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(request); return TransportResponse(statusCode: status, data: Data(reply.utf8))
    }
}
