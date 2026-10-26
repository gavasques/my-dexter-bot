import Foundation
import XCTest
@testable import DexterHostClient

final class BotMemoryHostClientTests: XCTestCase, @unchecked Sendable {
    func testOwnDocumentAutomationModesComeFromReadOnlyHostSnapshot() async throws {
        let modes: [BotDocumentsAutomation.Mode] = [.automatic, .ask, .denied, .expired]
        let responses = modes.map { mode in
            let payload = #"{"botId":"bot-a","revision":2,"soul":"personality","user":"preferences","memory":"notes","automation":{"version":"own-documents.v1","scope":"own_private","updates":"\#(mode.rawValue)","append":"\#(mode.rawValue)","clear":"exact_owner","restore":"exact_owner"}}"#
            return TransportResponse(statusCode: 200, data: Data(payload.utf8))
        }
        let transport = MemoryTransport(responses: responses)
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        for mode in modes {
            let documents = try await client.getBotDocuments(botID: "bot-a")
            XCTAssertEqual(documents.automation?.updates, mode)
            XCTAssertEqual(documents.automation?.append, mode)
            XCTAssertEqual(documents.memory, "notes")
        }
        let calls = await transport.requests()
        XCTAssertEqual(calls.map(\.httpMethod), Array(repeating: "GET", count: modes.count))
        XCTAssertTrue(calls.allSatisfy { $0.url?.path == "/v1/bots/bot-a/documents" && $0.httpBody == nil })
    }

    func testLegacyAndUnsupportedAutomationRemainUnknownWithoutHidingDocuments() async throws {
        let current = #"{"version":"own-documents.v1","scope":"own_private","updates":"automatic","append":"ask","clear":"exact_owner","restore":"exact_owner"}"#
        let invalid = [
            current.replacingOccurrences(of: "own-documents.v1", with: "own-documents.v2"),
            current.replacingOccurrences(of: "own_private", with: "team_shared"),
            current.replacingOccurrences(of: #""updates":"automatic""#, with: #""updates":"approve_all""#),
            current.replacingOccurrences(of: #""append":"ask""#, with: #""append":"unknown""#),
            current.replacingOccurrences(of: #""clear":"exact_owner""#, with: #""clear":"automatic""#),
            current.replacingOccurrences(of: #""restore":"exact_owner""#, with: #""restore":"automatic""#),
            "{}", "null"
        ]
        let legacy = #"{"botId":"bot-a","revision":2,"soul":"personality","user":"preferences","memory":"retained"}"#
        let payloads = [legacy] + invalid.map {
            #"{"botId":"bot-a","revision":2,"soul":"personality","user":"preferences","memory":"retained","automation":\#($0)}"#
        }
        let transport = MemoryTransport(responses: payloads.map { .init(statusCode: 200, data: Data($0.utf8)) })
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        for _ in payloads {
            let documents = try await client.getBotDocuments(botID: "bot-a")
            XCTAssertNil(documents.automation, "Unconfirmed policy must never be presented as automatic")
            XCTAssertEqual(documents.soul, "personality")
            XCTAssertEqual(documents.user, "preferences")
            XCTAssertEqual(documents.memory, "retained")
        }
    }

    func testAutomationMetadataDoesNotBypassBotIdentityOrOwnerTransport() async throws {
        let payload = #"{"botId":"other","revision":2,"soul":"","user":"","memory":"","automation":{"version":"own-documents.v1","scope":"own_private","updates":"automatic","append":"automatic","clear":"exact_owner","restore":"exact_owner"}}"#
        let transport = MemoryTransport(responses: [.init(statusCode: 200, data: Data(payload.utf8))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        do { _ = try await client.getBotDocuments(botID: "bot-a"); XCTFail("Must reject another bot's snapshot") }
        catch let error as HostClientError { XCTAssertEqual(error, .contractMismatch) }
        let paired = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, accessPolicy: .unpairedHost, transport: transport)
        defer { paired.close() }
        do { _ = try await paired.getBotDocuments(botID: "bot-a"); XCTFail("Automation metadata cannot enable owner reads") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
        let calls = await transport.requests(); XCTAssertEqual(calls.count, 1)
    }

    func testAmbiguousRestoreReadsOriginalReceiptOnlyAndPreservesUnicode() async throws {
        let input = RestoreBotMemoryInput(expectedRevision: 3, fromRevision: 1, clientRequestId: "original-restore", sourceReference: "declared 🚀")
        let response = Data(#"{"botId":"bot-a","revision":4,"soul":"CURRENT SOUL","user":"CURRENT USER","memory":"é 🚀 一","updatedAt":1,"memoryHead":{"botId":"bot-a","revision":4,"pin":{"path":"memory/bot-a/MEMORY-r4-00000000-0000-0000-0000-000000000000.md","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"source":{"kind":"owner_ui","ownerId":"owner","clientRequestId":"original-restore","reference":"declared 🚀"},"restoredFrom":1,"updatedAt":1},"receipt":{"botId":"bot-a","operationKey":"owner:original-restore","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"restore","revision":4,"source":{"kind":"owner_ui","ownerId":"owner","clientRequestId":"original-restore","reference":"declared 🚀"},"committedAt":1}}"#.utf8)
        let transport = MemoryTransport(responses: [.init(statusCode: 200, data: Data("ambiguous".utf8)), .init(statusCode: 200, data: response)])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        do { _ = try await client.restoreBotMemory(botID: "bot-a", input: input); XCTFail("Must retain original operation") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        let receipt = try await client.getBotDocumentReceipt(botID: "bot-a", clientRequestID: input.clientRequestId)
        XCTAssertEqual(receipt.memory, "é 🚀 一"); XCTAssertEqual(receipt.memoryHead?.restoredFrom, 1)
        let calls = await transport.requests()
        XCTAssertEqual(calls.map { $0.httpMethod }, ["POST", "GET"])
        XCTAssertEqual(calls[0].url?.path, "/v1/bots/bot-a/documents/memory/restore")
        XCTAssertEqual(calls[1].url?.path, "/v1/bots/bot-a/documents/receipts/owner:original-restore")
        let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls[0].httpBody))
        XCTAssertEqual(body, .object(["expectedRevision": .integer(3), "fromRevision": .integer(1), "clientRequestId": .string("original-restore"), "sourceReference": .string("declared 🚀")]))
    }
    func testOwnIdentityAndTransportLimitsRejectWithoutMutation() async throws {
        let transport = MemoryTransport(responses: [.init(statusCode: 200, data: Data(#"{"botId":"other","revision":1,"soul":"","user":"","memory":"other","updatedAt":1}"#.utf8))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        do { _ = try await client.getBotDocumentReceipt(botID: "bot-a", clientRequestID: "original"); XCTFail("Identity mismatch") }
        catch let error as HostClientError { XCTAssertEqual(error, .contractMismatch) }
        do { _ = try await client.restoreBotMemory(botID: "bot-a", input: .init(expectedRevision: 2, fromRevision: 1, clientRequestId: "bad/id")); XCTFail("Reject before POST") }
        catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        XCTAssertFalse(PutBotDocumentsInput(expectedRevision: 0, soul: "", user: "", memory: String(repeating: "🚀", count: 4097)).isValid)
        let paired = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, accessPolicy: .unpairedHost, transport: transport)
        defer { paired.close() }
        do { _ = try await paired.getBotMemoryHistory(botID: "bot-a"); XCTFail("Unsupported transport") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
        let calls = await transport.requests(); XCTAssertEqual(calls.count, 1)
    }
}
private actor MemoryTransport: HTTPTransport {
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
