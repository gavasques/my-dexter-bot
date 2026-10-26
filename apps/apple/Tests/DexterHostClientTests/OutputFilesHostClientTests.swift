import CryptoKit
import Foundation
import XCTest
@testable import DexterHostClient

/// Contract proof against REAL host responses: `Fixtures/output-files-golden.json` is produced by the TypeScript host routes
/// (HostServices + output folders, synthetic data). Swift request hashes must equal the host's; exported bytes must verify.
final class OutputFilesHostClientTests: XCTestCase, @unchecked Sendable {
    private struct Golden: Decodable { let hostId: String; let botId: String; let chosen: String; let deckSha256: String; let calls: [String: Call] }
    private struct Call: Decodable { let method: String; let path: String; let status: Int; let request: JSONValue?; let response: JSONValue?; let responseBase64: String? }
    private func golden() throws -> Golden {
        let url = Bundle.module.url(forResource: "output-files-golden", withExtension: "json")
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/output-files-golden.json")
        return try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
    }
    private func body(_ call: Call) throws -> Data {
        if let base64 = call.responseBase64 { return try XCTUnwrap(Data(base64Encoded: base64)) }
        return try JSONEncoder().encode(try XCTUnwrap(call.response))
    }
    private func scratch() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-output-export-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return url
    }

    func testRealHostResponsesDecodeExportVerifiesAndDestinationHashMatchesTheHost() async throws {
        let g = try golden()
        let order = ["status", "locations", "namespaces", "entries", "item", "content", "destination", "receipt", "statusAfter", "namespacesAfter"]
        let transport = OutputFilesTransport(responses: try order.map { TransportResponse(statusCode: g.calls[$0]!.status, data: try body(g.calls[$0]!)) })
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, transport: transport)
        defer { client.close() }
        let status = try await client.outputFilesStatus()
        XCTAssertEqual(status.hostId, g.hostId); XCTAssertEqual(status.revision, 1)
        XCTAssertEqual(status.current.kind, .hostDataLegacy); XCTAssertEqual(status.current.layout, .legacy)
        XCTAssertFalse(status.current.namespaces.general, "the legacy root is the data directory: no general listing")
        XCTAssertEqual(status.scope.groupTurns, "no_file_tools"); XCTAssertEqual(status.scope.sharing, "not_implemented")
        let locations = try await client.outputLocations()
        XCTAssertEqual(locations.items.map(\.generation), [1])
        let namespaces = try await client.outputNamespaces()
        let bot = try XCTUnwrap(namespaces.items.first { $0.ref == .bot(g.botId) })
        XCTAssertEqual(bot.label, "Analista é 📊", "display only; identity is the id"); XCTAssertEqual(bot.relativePath, "bot-files/\(g.botId)")
        let entries = try await client.outputEntries(namespace: .bot(g.botId))
        XCTAssertEqual(entries.items.map(\.name), ["notas", "slides"])
        let item = try await client.outputItem(namespace: .bot(g.botId), path: "slides/apresentação.pptx")
        XCTAssertEqual(item.sha256, g.deckSha256); XCTAssertEqual(item.bytes, 300)
        XCTAssertEqual(item.mediaType, "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        let folder = try scratch(); defer { try? FileManager.default.removeItem(at: folder) }
        let target = folder.appendingPathComponent("apresentação.pptx")
        let exported = try await client.exportOutputFile(item, to: target)
        XCTAssertEqual(exported.sha256, g.deckSha256); XCTAssertEqual(exported.bytes, 300)
        XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: target)).map { String(format: "%02x", $0) }.joined(), g.deckSha256)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["apresentação.pptx"], "no partial file left")
        let input = SetOutputDestinationInput(status: status, destination: .ownerPath(g.chosen), clientRequestId: "golden-destination-1")
        let receipt = try await client.setOutputDestination(input)
        XCTAssertEqual(receipt.requestHash, input.requestHash, "Swift and host canonical hashes agree")
        XCTAssertEqual(receipt.generation, 2); XCTAssertFalse(receipt.existingFilesMoved)
        let original = try await client.outputDestinationReceipt(clientRequestID: "golden-destination-1")
        XCTAssertEqual(original, receipt)
        let after = try await client.outputFilesStatus()
        XCTAssertEqual(after.current.kind, .ownerPath); XCTAssertEqual(after.current.path, g.chosen); XCTAssertTrue(after.current.namespaces.general)
        let namespacesAfter = try await client.outputNamespaces()
        XCTAssertEqual(namespacesAfter.items.first?.ref, .general)
        // Exact bytes sent equal what the host accepted.
        let sent = await transport.requests()
        XCTAssertEqual(sent.map { $0.httpMethod ?? "" }, order.map { g.calls[$0]!.method })
        let put = try XCTUnwrap(sent.first { $0.httpMethod == "PUT" })
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(put.httpBody)), g.calls["destination"]!.request)
        let chunk = try XCTUnwrap(sent.first { $0.url?.path == "/v1/output-files/content" })
        let query = URLComponents(url: try XCTUnwrap(chunk.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first { $0.name == "pin" }?.value, item.pin)
    }

    func testExportFailsClosedAndInvalidInputNeverReachesTheHost() async throws {
        let g = try golden()
        let itemData = try body(g.calls["item"]!), content = try body(g.calls["content"]!)
        // A chunk shorter than announced and a changed file (409) are integrity failures; nothing is published.
        let transport = OutputFilesTransport(responses: [.init(statusCode: 200, data: itemData), .init(statusCode: 200, data: content.prefix(100)),
                                                         .init(statusCode: 409, data: Data(#"{"error":"conflict","message":"x"}"#.utf8))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, transport: transport)
        defer { client.close() }
        let item = try await client.outputItem(namespace: .bot(g.botId), path: "slides/apresentação.pptx")
        let folder = try scratch(); defer { try? FileManager.default.removeItem(at: folder) }
        let target = folder.appendingPathComponent("deck.pptx")
        do { _ = try await client.exportOutputFile(item, to: target); XCTFail("short then changed must fail") }
        catch let error as OutputExportFailure { XCTAssertEqual(error, .changedDuringExport) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [], "partial removed, destination never created")
        FileManager.default.createFile(atPath: target.path, contents: Data("owner file".utf8))
        do { _ = try await client.exportOutputFile(item, to: target); XCTFail("never replaces an existing file") }
        catch let error as OutputExportFailure { XCTAssertEqual(error, .destinationExists) }
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "owner file")
        for path in ["../x", "/etc", "a//b", "a\\b", "x/./y"] {
            do { _ = try await client.outputEntries(namespace: .bot(g.botId), path: path); XCTFail(path) }
            catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest, path) }
        }
        XCTAssertNil(OutputNamespaceRef(rawValue: "bot:../x")); XCTAssertNil(OutputNamespaceRef(rawValue: "group:abc"))
        let status = try JSONDecoder().decode(OutputFilesStatus.self, from: try body(g.calls["status"]!))
        for bad in ["relative/folder", "", "/a\u{07}b"] {
            do { _ = try await client.setOutputDestination(.init(status: status, destination: .ownerPath(bad), clientRequestId: "bad")); XCTFail(bad) }
            catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        }
        let sent = await transport.requests(); XCTAssertEqual(sent.count, 3, "invalid input never reaches the host")
        // Remote (paired/unpaired) bases have no owner scope for output folders yet: refused locally, no path fallback.
        let remote = HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, accessPolicy: .unpairedHost, transport: transport)
        defer { remote.close() }
        do { _ = try await remote.outputFilesStatus(); XCTFail("owner loopback only") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
    }

    func testUnknownDestinationOutcomeIsNeverReportedAsSuccess() async throws {
        let g = try golden()
        let status = try JSONDecoder().decode(OutputFilesStatus.self, from: try body(g.calls["status"]!))
        var tampered = g.calls["destination"]!.response!
        if case .object(var object) = tampered { object["requestHash"] = .string(String(repeating: "0", count: 64)); tampered = .object(object) }
        let transport = OutputFilesTransport(responses: [.init(statusCode: 503, data: Data(#"{"error":"device_unavailable","message":"x"}"#.utf8)),
                                                         .init(statusCode: 200, data: try JSONEncoder().encode(tampered)),
                                                         .init(statusCode: 404, data: Data(#"{"error":"not_found","message":"x"}"#.utf8))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, transport: transport)
        defer { client.close() }
        let input = SetOutputDestinationInput(status: status, destination: .ownerPath(g.chosen), clientRequestId: "golden-destination-1")
        do { _ = try await client.setOutputDestination(input); XCTFail("503 is not success") }
        catch let error as HostClientError { XCTAssertEqual(error, .notReady) }
        do { _ = try await client.setOutputDestination(input); XCTFail("a receipt for another request is unknown") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        let missing = try await client.outputDestinationReceipt(clientRequestID: "golden-destination-1")
        XCTAssertNil(missing, "absent receipt is unconfirmed, never 'did not happen'")
    }
}

private actor OutputFilesTransport: HTTPTransport {
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
