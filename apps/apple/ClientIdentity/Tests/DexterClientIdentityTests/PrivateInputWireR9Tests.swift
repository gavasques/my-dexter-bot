import Foundation
import XCTest
@testable import DexterClientIdentity

final class PrivateInputWireR9Tests: XCTestCase {
    private func answer(_ text: String) -> [String: Any] {
        ["expectedHostID": "host_fixture", "clientRequestId": "00000000-0000-4000-8000-000000000001",
         "expectedRevision": 1, "actionId": "act_fixture", "requestHash": String(repeating: "a", count: 64),
         "responses": ["r1": ["action": "accept", "content": ["value": text]]], "approval": "approve_exact_input"]
    }

    // This exercises the SDK envelope boundary. Native per-content validation remains the host's responsibility.
    func testSlashRichPrivateEnvelopeAcceptsExactCapWithoutFoundationExpansion() throws {
        let route = ClientRoute.respondMcpInput(try ClientResourceID("mcpform_fixture"))
        let overhead = try JSONSerialization.data(withJSONObject: answer(""), options: [.sortedKeys, .withoutEscapingSlashes]).count
        let value = answer(String(repeating: "/", count: 528_384 - overhead))
        let compact = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        let escaped = try JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
        XCTAssertEqual(compact.count, 528_384)
        XCTAssertGreaterThan(escaped.count, 528_384)
        XCTAssertEqual(try ClientRequest(route: route, body: compact).body, compact)
        XCTAssertEqual(try ClientRequest.json(route: route, value: value).body, compact)
        print("R9 Foundation private boundary compact=\(compact.count) escaped=\(escaped.count)")
    }

    func testPrivateEnvelopeStillRejectsOneByteAboveCap() throws {
        let route = ClientRoute.respondMcpInput(try ClientResourceID("mcpform_fixture"))
        let overhead = try JSONSerialization.data(withJSONObject: answer(""), options: [.sortedKeys, .withoutEscapingSlashes]).count
        let value = answer(String(repeating: "/", count: 528_385 - overhead))
        let compact = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        XCTAssertEqual(compact.count, 528_385)
        XCTAssertThrowsError(try ClientRequest(route: route, body: compact))
        XCTAssertThrowsError(try ClientRequest.json(route: route, value: value))
    }

    func testGenericRequestKeepsOriginalSlashEncodingAndExact64KiBCap() throws {
        let route = ClientRoute.appendMessage(try ClientResourceID("thread_fixture"))
        func value(_ text: String) -> [String: Any] { ["clientMessageId": "message_fixture", "content": text] }
        let overhead = try JSONSerialization.data(withJSONObject: value(""), options: .sortedKeys).count
        let slashes = 65_536 - overhead - 32_768
        let text = String(repeating: "/", count: slashes) + String(repeating: "a", count: 32_768 - slashes)
        let exact = try JSONSerialization.data(withJSONObject: value(text), options: .sortedKeys)
        XCTAssertEqual(exact.count, 65_536)
        XCTAssertEqual(try ClientRequest.json(route: route, value: value(text)).body, exact)
        XCTAssertTrue(String(decoding: exact, as: UTF8.self).contains("\\/"))
        let over = value(String(repeating: "/", count: slashes + 1) + String(repeating: "a", count: 32_767 - slashes))
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: over, options: .sortedKeys).count, 65_537)
        XCTAssertThrowsError(try ClientRequest.json(route: route, value: over))
    }
}
