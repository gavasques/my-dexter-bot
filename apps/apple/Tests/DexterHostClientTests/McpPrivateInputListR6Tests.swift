import Foundation
import XCTest
@testable import DexterHostClient

final class McpPrivateInputListR6Tests: XCTestCase {
    private func row(_ id: String, message: String = "Synthetic preference", pattern: String? = nil) -> String {
        let extra = pattern.map { #","pattern":\#(String(decoding: try! JSONEncoder().encode($0), as: UTF8.self))"# } ?? ""
        return #"{"version":1,"id":"\#(id)","actionId":"act_r6","requestHash":"\#(String(repeating: "a", count: 64))","connectionId":"conn_r6","botId":"bot_r6","threadId":"thread_r6","revision":1,"state":"pending","requests":{"r1":{"method":"elicitation/create","params":{"message":"\#(message)","requestedSchema":{"type":"object","properties":{"value":{"type":"string"\#(extra)}}}}}},"createdAt":1,"expiresAt":9000000000000}"#
    }
    func testMalformedRowsCannotPoisonValidSiblingsOrClaimCompleteness() throws {
        let good = row("good"), loneHigh = row("bad_high", message: #"\ud800"#), loneLow = row("bad_low", message: #"\udfff"#)
        let unsupported = row("bad_pattern", pattern: #"^a\$"#)
        let unknown = good.replacingOccurrences(of: #""id":"good""#, with: #""id":"bad_unknown","opaque":"ordinary""#)
        let body = #"{"requests":[\#(loneHigh),\#(good),\#(loneLow),null,\#(unsupported),\#(unknown)],"invalidRequestCount":2,"quarantinedRequestCount":3,"omittedRequestCount":7,"incomplete":false}"#
        let result = try JSONDecoder().decode(McpPrivateInputs.self, from: Data(body.utf8))
        XCTAssertEqual(result.requests.map(\.id), ["good"])
        XCTAssertEqual(result.invalidRequestCount, 7)
        XCTAssertEqual(result.quarantinedRequestCount, 3)
        XCTAssertEqual(result.omittedRequestCount, 7)
        XCTAssertTrue(result.incomplete)
        XCTAssertNotNil(result.requests.first?.forms)
    }
    func testDuplicateIdentitiesAreBothNonactionableAndEmptyListCanBeIncomplete() throws {
        let body = #"{"requests":[\#(row("same")),\#(row("same")),\#(row("other"))]}"#
        let result = try JSONDecoder().decode(McpPrivateInputs.self, from: Data(body.utf8))
        XCTAssertEqual(result.requests.map(\.id), ["other"])
        XCTAssertEqual(result.invalidRequestCount, 2)
        XCTAssertTrue(result.incomplete)
        let empty = try JSONDecoder().decode(McpPrivateInputs.self, from: Data(#"{"requests":[],"quarantinedRequestCount":1}"#.utf8))
        XCTAssertTrue(empty.incomplete); XCTAssertTrue(empty.requests.isEmpty)
    }
    func testCompleteListAndInvalidCountersRemainDistinct() throws {
        let complete = try JSONDecoder().decode(McpPrivateInputs.self, from: Data(#"{"requests":[]}"#.utf8))
        XCTAssertFalse(complete.incomplete)
        for count in ["-1", "50001", "true", "null"] {
            // Null means absent for backwards-compatible optional counters; malformed/negative counters fail closed.
            if count == "null" { continue }
            XCTAssertThrowsError(try JSONDecoder().decode(McpPrivateInputs.self, from: Data("{\"requests\":[],\"invalidRequestCount\":\(count)}".utf8)))
        }
    }
}
