import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

@MainActor final class McpPrivateFormRecoveryTests: XCTestCase {
    func testIncompleteListKeepsValidSiblingAndExplicitCountsWithoutSending() async throws {
        let host = R4PrivateFormHost(incomplete: true)
        let editor = McpPrivateInputEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49987")!, transport: host), ownsClient: true, scope: "synthetic-r6")
        defer { editor.close() }
        await editor.load()
        XCTAssertTrue(editor.listIncomplete)
        XCTAssertEqual(editor.invalidRequestCount, 3)
        XCTAssertEqual(editor.quarantinedRequestCount, 2)
        XCTAssertEqual(editor.omittedRequestCount, 4)
        XCTAssertEqual(editor.open(now: 0).count, 1)
        XCTAssertNil(editor.pending)
        let count = await host.count()
        XCTAssertEqual(count, 0)
    }
    func testFinalHostRejectionKeepsSameFormAndRequiresFreshExactReview() async throws {
        let host = R4PrivateFormHost()
        let editor = McpPrivateInputEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49989")!, transport: host), ownsClient: true, scope: "synthetic-r4")
        defer { editor.close() }
        await editor.load()
        let input = try XCTUnwrap(editor.open(now: 0).first)
        await editor.respond(input, answer: .accept(["r1": ["email": .string("invalid-email")]]))
        XCTAssertEqual(editor.notice, .invalidAnswer)
        XCTAssertNil(editor.pending, "no raw rejected values retained in the editor")
        XCTAssertEqual(editor.open(now: 0).first, input, "same revision/action/hash remain editable")
        let firstCount = await host.count()
        XCTAssertEqual(firstCount, 1)
        await editor.load()
        let refreshedCount = await host.count()
        XCTAssertEqual(refreshedCount, 1, "refresh never repeats a response")
        await editor.respond(input, answer: .accept(["r1": ["email": .string("reader@example.test")]]))
        XCTAssertEqual(editor.notice, .answered(.answered))
        XCTAssertNil(editor.pending)
        let bodies = await host.requests()
        XCTAssertEqual(bodies.count, 2, "one new POST only after a new explicit reviewed answer")
        XCTAssertNotEqual(bodies[0]["clientRequestId"], bodies[1]["clientRequestId"])
        for body in bodies {
            XCTAssertEqual(body["actionId"], .string(input.actionId))
            XCTAssertEqual(body["requestHash"], .string(input.requestHash))
            XCTAssertEqual(body["expectedRevision"], .integer(1))
            XCTAssertEqual(body["approval"], .string("approve_exact_input"))
            XCTAssertNil(body["requestState"])
        }
    }
    func testInvalidLocalBoundsSendNothingAndNeverAutofillDefaults() async throws {
        let host = R4PrivateFormHost()
        let editor = McpPrivateInputEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49988")!, transport: host), ownsClient: true, scope: "synthetic-r4")
        defer { editor.close() }
        await editor.load()
        let input = try XCTUnwrap(editor.open(now: 0).first)
        await editor.respond(input, answer: .accept(["r1": [:]]))
        XCTAssertEqual(editor.notice, .invalidAnswer)
        await editor.respond(input, answer: .accept(["r1": ["email": .string(String(repeating: "a", count: 201))]]))
        XCTAssertEqual(editor.notice, .invalidAnswer)
        let count = await host.count()
        XCTAssertEqual(count, 0)
        await editor.respond(input, answer: .decline)
        XCTAssertEqual(editor.notice, .answered(.declined))
        let bodies = await host.requests()
        XCTAssertEqual(bodies.count, 1)
        XCTAssertNil(bodies[0]["approval"])
        XCTAssertEqual(bodies[0]["responses"], .object(["r1": .object(["action": .string("decline")])]))
    }
}

private actor R4PrivateFormHost: HTTPTransport {
    private let incomplete: Bool
    init(incomplete: Bool = false) { self.incomplete = incomplete }
    private var posted: [[String: JSONValue]] = []
    private var state = "pending", revision = 1, clientRequestId: String?
    func count() -> Int { posted.count }
    func requests() -> [[String: JSONValue]] { posted }
    private func input() -> String {
        let client = clientRequestId.map { "\"\($0)\"" } ?? "null"
        return #"{"version":1,"id":"mcpform_r4","actionId":"act_r4","requestHash":"\#(String(repeating: "b", count: 64))","connectionId":"conn_r4","botId":"bot_r4","threadId":"thread_r4","revision":\#(revision),"state":"\#(state)","requests":{"r1":{"method":"elicitation/create","params":{"message":"Synthetic email preference","requestedSchema":{"type":"object","properties":{"email":{"type":"string","format":"email","maxLength":200,"default":"default@example.test"}},"required":["email"],"additionalProperties":false}}}},"createdAt":1,"expiresAt":9000000000000,"responseHash":null,"clientRequestId":\#(client)}"#
    }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url?.path ?? ""
        if path == "/health" { return TransportResponse(statusCode: 200, data: Data(#"{"protocolVersion":1,"mode":"local-development","engineRouting":"synthetic","remotePairing":"not_implemented","hostId":"host_r4","state":{}}"#.utf8)) }
        if path == "/v1/mcp/input-requests" { return TransportResponse(statusCode: 200, data: Data((incomplete ? "{\"requests\":[null,\(input())],\"invalidRequestCount\":2,\"quarantinedRequestCount\":2,\"omittedRequestCount\":4,\"incomplete\":true}" : "{\"requests\":[\(input())]}").utf8)) }
        if path == "/v1/mcp/input-requests/mcpform_r4/respond" {
            let body = try JSONDecoder().decode([String: JSONValue].self, from: request.httpBody ?? Data())
            posted.append(body)
            if case .object(let responses)? = body["responses"], case .object(let response)? = responses["r1"] {
                if response["action"] == .string("decline") { state = "declined" }
                else if response["content"] == .object(["email": .string("reader@example.test")]) { state = "answered" }
                else { return TransportResponse(statusCode: 400, data: Data(#"{"error":"invalid_input","message":"MCP form response does not match the reviewed contract."}"#.utf8)) }
            }
            if case .string(let id)? = body["clientRequestId"] { clientRequestId = id }
            revision += 1
            return TransportResponse(statusCode: 200, data: Data(input().utf8))
        }
        return TransportResponse(statusCode: 404, data: Data())
    }
}
