import Foundation
import XCTest
@testable import DexterHostClient

final class McpPrivateFormParityTests: XCTestCase {
    private struct Case: Decodable { let name: String, requestJSON: String; let responseJSON: String?; let accepted: Bool? }
    private struct Fixture: Decodable { let positive, negative, negativeResponses, hostFinalResponses, patternCases: [Case] }
    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mcp-private-form-r3", withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    private func input(_ item: Case) throws -> McpPrivateInput {
        let text = #"{"version":1,"id":"mcpform_1","actionId":"act_1","requestHash":"\#(String(repeating: "a", count: 64))","connectionId":"conn_1","botId":"bot_1","threadId":"thread_1","revision":1,"state":"pending","requests":\#(item.requestJSON),"createdAt":1,"expiresAt":300001}"#
        return try JSONDecoder().decode(McpPrivateInput.self, from: Data(text.utf8))
    }
    private func contents(_ item: Case) throws -> [String: [String: JSONValue]] {
        let responses = try JSONDecoder().decode([String: JSONValue].self, from: Data(try XCTUnwrap(item.responseJSON).utf8))
        var contents: [String: [String: JSONValue]] = [:]
        for (key, value) in responses {
            guard case .object(let response) = value, case .object(let content)? = response["content"] else { throw HostClientError.invalidRequest }
            contents[key] = content
        }
        return contents
    }
    func testSharedClosedRequestsAndExactPrimitiveAnswers() throws {
        let fixture = try fixture()
        for item in fixture.positive {
            let input = try input(item)
            XCTAssertNotNil(input.forms, item.name)
            let expected = try contents(item)
            let answer = try XCTUnwrap(RespondMcpPrivateInputInput(input: input, hostID: "host_1", answer: .accept(expected)), item.name)
            XCTAssertEqual(answer.approval, "approve_exact_input")
            let responses = try JSONDecoder().decode([String: JSONValue].self, from: Data(item.responseJSON!.utf8))
            XCTAssertEqual(answer.responses, responses, "no defaults or extra values are inserted: \(item.name)")
            for (formKey, fields) in expected {
                guard case .object(let sent)? = answer.responses[formKey], case .object(let content)? = sent["content"] else { return XCTFail("exact content") }
                for (field, value) in fields {
                    if case .string(let text) = value {
                        guard case .string(let actual)? = content[field] else { return XCTFail("exact string") }
                        XCTAssertEqual(Data(actual.utf8), Data(text.utf8), "Unicode scalar bytes must stay original: \(item.name)")
                    }
                }
            }
            let encoded = String(decoding: try JSONEncoder().encode(answer), as: UTF8.self)
            XCTAssertFalse(encoded.contains("requestState")); XCTAssertFalse(encoded.contains("opaque-round1")); XCTAssertFalse(encoded.contains("_meta"))
        }
        for item in fixture.negative {
            let decoded = try? input(item)
            XCTAssertNil(decoded?.forms, item.name)
            if let decoded {
                XCTAssertNil(RespondMcpPrivateInputInput(input: decoded, hostID: "host_1", answer: .decline), item.name)
                XCTAssertNil(RespondMcpPrivateInputInput(input: decoded, hostID: "host_1", answer: .cancel), item.name)
            }
        }
        for item in fixture.negativeResponses {
            let input = try input(item); XCTAssertNotNil(input.forms, item.name)
            if let content = try? contents(item) {
                XCTAssertNil(RespondMcpPrivateInputInput(input: input, hostID: "host_1", answer: .accept(content)), item.name)
            } // Ill-formed UTF-16 cannot become a Swift answer.
        }
        print("R6 MRTR shared: \(fixture.positive.count) accepted requests/answers, \(fixture.negative.count) refused requests, \(fixture.negativeResponses.count) refused answers")
    }
    func testTextFormatsAndPatternsDeferValidationToHostWithoutExecutingRegex() throws {
        let fixture = try fixture()
        for item in fixture.hostFinalResponses {
            let input = try input(item)
            let form = try XCTUnwrap(input.forms?.first)
            guard case .text = form.fields.first?.kind else { return XCTFail("constraints render ordinary text") }
            // These invalid format/pattern strings are carried to the host for final validation; the local editor
            // cannot certify them. The host tests must reject them before private-state consumption/next RPC.
            XCTAssertNotNil(RespondMcpPrivateInputInput(input: input, hostID: "host_1", answer: .accept(try contents(item))), item.name)
        }
        print("R6 MRTR host-final constraints: \(fixture.hostFinalResponses.count)")
    }
    func testGeneratedPatternGrammarMatchesHostFromExactJSONBytes() throws {
        let cases = try fixture().patternCases
        XCTAssertGreaterThanOrEqual(cases.count, 2000)
        var accepted = 0
        for item in cases {
            let renderable = try input(item).forms != nil
            XCTAssertEqual(renderable, item.accepted, item.name)
            if renderable { accepted += 1 }
        }
        print("R6 MRTR generated patterns: \(cases.count), accepted \(accepted), refused \(cases.count - accepted)")
    }
}
