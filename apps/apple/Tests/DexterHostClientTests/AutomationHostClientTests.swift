import Foundation
import XCTest
@testable import DexterHostClient

/// Synthetic HTTP only; no real listener, provider, preference or calendar account.
private actor AutomationSyntheticTransport: HTTPTransport {
    var responses: [TransportResponse?]
    var requests: [URLRequest] = []
    init(_ responses: [TransportResponse?]) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(request)
        guard !responses.isEmpty, let response = responses.removeFirst() else { throw HostClientError.offline }
        return response
    }
    func captured() -> [URLRequest] { requests }
}
final class AutomationHostClientTests: XCTestCase, @unchecked Sendable {
    func testCanonicalPreviewPinsHostAndDoesNotCreateAnything() async throws {
        let when = AutomationWhen.cron(expression: "0 9 * * 1-5", timeZone: "America/Sao_Paulo")
        let response = try JSONSerialization.data(withJSONObject: ["hostId": "host_synthetic", "when": ["kind": "cron", "expression": "0 9 * * 1-5", "timeZone": "America/Sao_Paulo"], "dates": [2_000_000_000_000]])
        let transport = AutomationSyntheticTransport([TransportResponse(statusCode: 200, data: response)])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:45998")!, transport: transport)
        let preview = try await client.previewAutomation(hostID: "host_synthetic", when: when, after: 1_900_000_000_000)
        XCTAssertEqual(preview.dates, [2_000_000_000_000])
        let requests = await transport.captured()
        XCTAssertEqual(requests.count, 1); XCTAssertEqual(requests.first?.url?.path, "/v1/automations/preview")
        let mismatch = AutomationSyntheticTransport([TransportResponse(statusCode: 200, data: response)])
        let wrongHost = HostClient(baseURL: URL(string: "http://127.0.0.1:45998")!, transport: mismatch)
        do { _ = try await wrongHost.previewAutomation(hostID: "host_other", when: when); XCTFail("A new host cannot fulfill an old host's preview") }
        catch let error as HostClientError { XCTAssertEqual(error, .contractMismatch) }
    }
    func testUnknownMutationHasNoAutomaticResendAndExplicitRetryPreservesExactRequest() async throws {
        let id = "12345678-1234-1234-1234-123456789abc"
        let input = AutomationMutation(hostId: "host_synthetic", clientRequestId: id, expectedRevision: 1)
        let schedule: [String: Any] = ["id": "schedule_synthetic", "ownerId": "owner_synthetic", "installationId": "host_synthetic", "botId": "bot_synthetic", "threadId": "thread_synthetic", "title": "QA", "content": "Synthetic text", "kind": "once", "at": 2_000_000_000_000, "intervalMs": NSNull(), "nextAt": NSNull(), "cron": NSNull(), "timeZone": NSNull(), "state": "completed", "revision": 1, "createdAt": 1_900_000_000_000, "updatedAt": 1_900_000_000_000]
        let receipt = try JSONSerialization.data(withJSONObject: ["id": "receipt_synthetic", "hostId": "host_synthetic", "clientRequestId": id, "operation": "run", "scheduleId": "schedule_synthetic", "revision": 1, "createdAt": 1_900_000_000_000, "replayed": true, "schedule": schedule, "occurrence": ["state": "accepted", "turnId": "turn_synthetic"]])
        let transport = AutomationSyntheticTransport([nil, TransportResponse(statusCode: 200, data: receipt)])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:45998")!, transport: transport)
        do { _ = try await client.mutateAutomation(id: "schedule_synthetic", operation: "run", input: input); XCTFail("Lost transport must remain uncertain") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        let first = await transport.captured(); XCTAssertEqual(first.count, 1)
        let result = try await client.mutateAutomation(id: "schedule_synthetic", operation: "run", input: input)
        let retried = await transport.captured(); XCTAssertEqual(retried.count, 2)
        XCTAssertEqual(retried[0].url, retried[1].url)
        let firstJSON = try JSONSerialization.jsonObject(with: XCTUnwrap(retried[0].httpBody)) as? NSDictionary
        let nextJSON = try JSONSerialization.jsonObject(with: XCTUnwrap(retried[1].httpBody)) as? NSDictionary
        XCTAssertEqual(firstJSON, nextJSON)
        XCTAssertTrue(result.replayed); XCTAssertEqual(result.clientRequestId, id)
        if case .object(let occurrence) = result.occurrence { XCTAssertEqual(occurrence["state"], .string("accepted")) }
        else { XCTFail("Receipt must preserve the accepted occurrence without pretending completion") }
    }
}
