import Foundation
import XCTest
@testable import DexterHostClient
@testable import DexterClientIdentity

private actor R9WireCapture: HTTPTransport {
    let reply: Data
    var bodies: [Data] = []
    init(reply: Data) { self.reply = reply }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        bodies.append(request.httpBody ?? Data())
        return .init(statusCode: 200, data: reply)
    }
    func captured() -> [Data] { bodies }
}

private actor R9PairedWireCapture: PairedNativeSending {
    nonisolated let native: NativeHostTransport
    var bodies: [Data] = []
    init(native: NativeHostTransport) { self.native = native }
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        if case .respondMcpInput = request.route { bodies.append(request.body) }
        return try await native.send(request)
    }
    nonisolated func close() -> ClientTransportClose { native.close() }
    func captured() -> [Data] { bodies }
}

private actor R9ClaimJournal: ClientClaimJournal {
    var entry: ClientClaimJournalEntry?
    func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry? { entry }
    func reserve(_ reservation: ClientClaimReservation) async throws {
        guard entry == nil else { throw ClientIdentityFailure.conflict }
        entry = try .init(reservation: reservation, claimID: nil)
    }
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws {
        guard entry?.reservation.matches(reservation) == true else { throw ClientIdentityFailure.conflict }
        entry = try .init(reservation: reservation, claimID: claimID)
    }
}

@MainActor final class McpPrivateInputWireR9Tests: XCTestCase {
    private func compact<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    // Eight contents at the actual unchanged native 65,536-byte cap, with >26,000 slashes per content.
    // NULs account for JSON escaping while decoded text remains below the existing 32 KiB form limit.
    private func maximumContents(_ input: McpPrivateInput) throws -> [String: [String: JSONValue]] {
        try Dictionary(uniqueKeysWithValues: XCTUnwrap(input.forms).map { form in
            var fields = Dictionary(uniqueKeysWithValues: form.fields.map { ($0.name, JSONValue.string("")) })
            XCTAssertTrue(["v0", "v1", "v2", "v3", "v4"].allSatisfy { fields[$0] != nil })
            fields["v0"] = .string(String(repeating: "/", count: 10_000))
            fields["v1"] = .string(String(repeating: "/", count: 10_000))
            fields["v2"] = .string(String(repeating: "/", count: 6_000))
            let remaining = 65_536 - (try compact(fields).count)
            fields["v3"] = .string(String(repeating: "\0", count: remaining / 6))
            fields["v4"] = .string(String(repeating: "/", count: remaining % 6))
            XCTAssertEqual(try compact(fields).count, 65_536)
            XCTAssertNotNil(form.content(fields))
            return (form.key, fields)
        })
    }

    private func fixtureInput() throws -> McpPrivateInput {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mcp-private-form-r3", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let positive = try XCTUnwrap(fixture["positive"] as? [[String: Any]])
        let item = try XCTUnwrap(positive.first { $0["name"] as? String == "r7-max-8x64KiB-schema-2048-message-128-id" })
        let requests = try XCTUnwrap(item["requestJSON"] as? String)
        let text = #"{"version":1,"id":"mcpform_fixture","actionId":"act_fixture","requestHash":"\#(String(repeating: "a", count: 64))","connectionId":"conn_fixture","botId":"bot_fixture","threadId":"thread_fixture","revision":1,"state":"pending","requests":\#(requests),"createdAt":1,"expiresAt":300001,"responseHash":null,"clientRequestId":null}"#
        return try JSONDecoder().decode(McpPrivateInput.self, from: Data(text.utf8))
    }

    func testHostClientEncodesMaximumLegitimateSlashRichAnswersWithoutWireInflation() async throws {
        let input = try fixtureInput()
        let answer = try XCTUnwrap(RespondMcpPrivateInputInput(input: input, hostID: "host_fixture", answer: .accept(try maximumContents(input))))
        let expected = try compact(answer), escaped = try JSONEncoder().encode(answer)
        XCTAssertLessThan(expected.count, 528_384)
        XCTAssertGreaterThan(escaped.count, 528_384)
        var receipt = try XCTUnwrap(JSONSerialization.jsonObject(with: compact(input)) as? [String: Any])
        receipt["state"] = "answered"; receipt["revision"] = 2
        receipt["responseHash"] = String(repeating: "b", count: 64); receipt["clientRequestId"] = answer.clientRequestId
        let transport = R9WireCapture(reply: try JSONSerialization.data(withJSONObject: receipt))
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport)
        defer { client.close() }
        let saved = try await client.respondMcpPrivateInput(id: input.id, answer)
        XCTAssertEqual(saved.state, .answered)
        let bodies = await transport.captured(), body = try XCTUnwrap(bodies.first)
        XCTAssertEqual(bodies.count, 1); XCTAssertEqual(body.count, expected.count)
        XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("\\/"))
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: body), try JSONDecoder().decode(JSONValue.self, from: expected))
        print("R9 maximum legitimate answer compact=\(expected.count) defaultFoundation=\(escaped.count) perContent=65536 forms=8")
    }

    func testHostClientGenericBodyRetainsExistingFoundationSlashEncoding() async throws {
        struct Input: Encodable { let value: String }
        let input = Input(value: "https://example.test/synthetic/path")
        let transport = R9WireCapture(reply: Data("{}".utf8))
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport)
        defer { client.close() }
        let _: [String: String] = try await client.request("/v1/synthetic", method: "POST", body: input)
        let bodies = await transport.captured(), body = try XCTUnwrap(bodies.first)
        XCTAssertEqual(body, try JSONEncoder().encode(input))
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("\\/"))
    }

    func testRealProductPairedTLSSlashRichMaximumAnswerReconcilesAndReplays() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let node = env["DEXTER_TEST_NODE"], let source = env["DEXTER_R8_SOURCE"] else {
            throw XCTSkip("Requires isolated source build and explicit Node executable, as the R8 SDK fixture")
        }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [source + "/tests/fixtures/r8-private-input-sdk-host.mjs"]
        process.environment = ["DEXTER_R8_SOURCE": source, "PATH": "/usr/bin:/bin"]
        process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        var line = Data()
        while line.count < 32_768 {
            guard let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { throw ClientIdentityFailure.unavailable }
            if byte.first == 10 { break }; line.append(byte)
        }
        let info = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
        let raw = try XCTUnwrap(info["bundle"] as? [String: Any])
        let url = try XCTUnwrap(URL(string: XCTUnwrap(raw["hostUrl"] as? String)))
        let der = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(raw["hostCertificateDER"] as? String)))
        let host = try PinnedClientHost(url: url, certificateDER: der, fingerprint: XCTUnwrap(raw["hostFingerprint"] as? String))
        let installation = try XCTUnwrap(raw["installationId"] as? String)
        let bundle = try ClientPairingBundle(host: host, installationID: installation, offerID: XCTUnwrap(raw["offerId"] as? String), role: .clientMac,
            expiresAt: Date(timeIntervalSince1970: XCTUnwrap(raw["expiresAt"] as? Double) / 1000), code: XCTUnwrap(raw["code"] as? String))
        let identity = try ClientNativeIdentity.ephemeralFixture()
        let scope = try ClientIdentityScope(installationID: installation, localBindingID: String(repeating: "f", count: 32), role: .clientMac, hostFingerprint: host.fingerprint)
        let pairing = try ClientPairingSession(bundle: bundle, scope: scope, identity: identity, journal: R9ClaimJournal())
        _ = try await pairing.begin(name: "R9 slash wire synthetic")
        var approved: PairedHostBinding?
        for _ in 0..<100 {
            if case .approved(let binding) = try await pairing.status() { approved = binding; break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let binding = try XCTUnwrap(approved)
        let native = try NativeHostTransport(identity: identity, binding: binding), capture = R9PairedWireCapture(native: native)
        let transport = PairedHTTPTransport(binding: binding, sender: capture)
        let client = HostClient(baseURL: url, accessPolicy: .pairedHost(binding), transport: transport)
        defer { client.close() }
        let input = try await client.mcpPrivateInput(id: XCTUnwrap(info["inputId"] as? String))
        let answer = try XCTUnwrap(RespondMcpPrivateInputInput(input: input, hostID: installation, answer: .accept(try maximumContents(input))))
        let expected = try compact(answer)
        XCTAssertLessThan(expected.count, 528_384); XCTAssertGreaterThan(try JSONEncoder().encode(answer).count, 528_384)
        let receipt = try await client.respondMcpPrivateInput(id: input.id, answer)
        XCTAssertEqual(receipt.state, .answered); XCTAssertEqual(receipt.clientRequestId, answer.clientRequestId)
        let reconciled = try await client.mcpPrivateInput(id: input.id)
        XCTAssertEqual(reconciled, receipt)
        let replay = try await client.respondMcpPrivateInput(id: input.id, answer)
        XCTAssertEqual(replay, receipt)
        let bodies = await capture.captured()
        // ClientRequest owns canonical ordering; JSONEncoder's sorted-key order can differ from JSONSerialization's.
        let canonical = try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: expected), options: [.sortedKeys, .withoutEscapingSlashes])
        XCTAssertEqual(bodies, [canonical, canonical], "the actual NativeHostTransport receives the same exact canonical bytes on replay")
        print("R9 paired actual SDK answerBytes=\(expected.count) perContent=65536 forms=8 replayIdentical=true")
        await client.close().value
    }
}
