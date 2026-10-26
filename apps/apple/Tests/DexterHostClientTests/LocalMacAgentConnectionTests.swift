import CryptoKit
import Foundation
import XCTest
@testable import DexterHostClient

/// Public synthetic certificate + scripted transport only. No Keychain, account, permissions or pairing.
@MainActor final class LocalMacAgentConnectionTests: XCTestCase {
    private func object() throws -> [String: Any] {
        let url = Bundle.module.url(forResource: "local-mac-agent-connection-golden", withExtension: "json")
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/local-mac-agent-connection-golden.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func text(_ object: [String: Any]) throws -> String {
        try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: object), encoding: .utf8))
    }
    private func payload() throws -> Data { try JSONSerialization.data(withJSONObject: object()) }

    func testClosedPublicCertificateDescriptionAndExpectedInstallation() throws {
        let json = try text(object())
        let result = try LocalMacAgentConnectionDescription(json: json, expectedInstallationID: "host_synthetic")
        XCTAssertEqual(result.installationID, "host_synthetic")
        XCTAssertEqual(result.hostURL, "https://127.0.0.1:4999")
        XCTAssertEqual(result.hostFingerprint, SHA256.hash(data: result.certificateDER).map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(try LocalMacAgentConnectionDescription(json: json), result)
        XCTAssertThrowsError(try LocalMacAgentConnectionDescription(json: json, expectedInstallationID: "host_other"))
        var ipv6 = try object(); ipv6["hostUrl"] = "https://[::1]:4999"
        XCTAssertEqual(try LocalMacAgentConnectionDescription(json: text(ipv6)).hostURL, "https://[::1]:4999")
    }

    func testRejectsExtraKeysBadScopeRemoteEndpointsAndInvalidCertificatePin() throws {
        let original = try object()
        let pem = try XCTUnwrap(original["hostCertPem"] as? String)
        for (key, value) in [
            ("schema", "dexter.local-mac-agent-setup/1"), ("installationId", ""), ("installationId", "../host"),
            ("hostFingerprint", String(repeating: "f", count: 64)), ("hostFingerprint", String(repeating: "A", count: 64)),
            ("hostCertPem", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"),
            ("hostCertPem", pem + pem), ("hostCertPem", pem + "PRIVATE MATERIAL"),
            ("hostUrl", "http://127.0.0.1:4999"), ("hostUrl", "https://remote.example:4999"),
            ("hostUrl", "https://localhost:4999"), ("hostUrl", "https://127.0.0.2:4999"),
            ("hostUrl", "https://127.0.0.1"), ("hostUrl", "https://127.0.0.1:0"),
            ("hostUrl", "https://127.0.0.1:65536"), ("hostUrl", "https://user@127.0.0.1:4999"),
            ("hostUrl", "https://127.0.0.1:4999/"), ("hostUrl", "https://127.0.0.1:4999/private"),
            ("hostUrl", "https://127.0.0.1:4999?code=fake"), ("hostUrl", "https://127.0.0.1:4999#pin"),
            ("hostUrl", "https://127.0.0.1:04999")
        ] {
            var changed = original; changed[key] = value
            XCTAssertThrowsError(try LocalMacAgentConnectionDescription(json: text(changed)), "\(key)=\(key == "hostCertPem" ? "<public fixture>" : value)") {
                XCTAssertEqual($0 as? HostClientError, .contractMismatch)
            }
        }
        for key in ["offerId", "code", "claimId", "grants", "privateKey", "ownerId"] {
            var changed = original; changed[key] = "synthetic"
            XCTAssertThrowsError(try LocalMacAgentConnectionDescription(json: text(changed)))
        }
        var missing = original; missing.removeValue(forKey: "hostFingerprint")
        XCTAssertThrowsError(try LocalMacAgentConnectionDescription(json: text(missing)))
        XCTAssertThrowsError(try LocalMacAgentConnectionDescription(json: String(repeating: " ", count: 32769)))
    }

    func testOwnerGETUsesProtectedTransportWithoutCacheBodyOrImplicitMutation() async throws {
        let transport = MacConnectionTransport([.success(200, try payload()), .success(200, try payload())])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:4998")!, transport: transport)
        let first = try await client.localMacAgentConnection(), second = try await client.localMacAgentConnection()
        XCTAssertEqual(first, second)
        let requests = await transport.sent(), protected = await transport.protectedCount()
        XCTAssertEqual(requests.count, 2); XCTAssertEqual(protected, 2)
        for request in requests {
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/v1/local-mac-agent/connection")
            XCTAssertNil(request.url?.query); XCTAssertNil(request.httpBody)
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
            XCTAssertEqual(request.timeoutInterval, 15)
        }
    }

    func testDeniedPoliciesAndBadBaseSendNothing() async throws {
        let transport = MacConnectionTransport([])
        let unpaired = HostClient(baseURL: URL(string: "https://remote.example")!, accessPolicy: .unpairedHost, transport: transport)
        do { _ = try await unpaired.localMacAgentConnection(); XCTFail() }
        catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let foreign = HostClient(baseURL: URL(string: "http://remote.example")!, transport: transport)
        do { _ = try await foreign.localMacAgentConnection(); XCTFail() }
        catch { XCTAssertEqual(error as? HostClientError, .remotePairingUnavailable) }
        let sent = await transport.sent(); XCTAssertTrue(sent.isEmpty)
    }

    func testRedirectOfflineMissingAndMalformedRepliesNeverRetryOrInventTrust() async throws {
        for (step, expected) in [
            (MacConnectionTransport.Step.success(302, try payload()), HostClientError.hostFailure),
            (.success(503, Data()), .notReady), (.success(409, Data()), .conflict),
            (.success(200, Data("{}".utf8)), .contractMismatch),
            (.success(200, Data("not json".utf8)), .contractMismatch),
            (.failure(URLError(.networkConnectionLost)), .offline)
        ] {
            let transport = MacConnectionTransport([step])
            let client = HostClient(baseURL: URL(string: "http://127.0.0.1:4998")!, transport: transport)
            do { _ = try await client.localMacAgentConnection(); XCTFail() }
            catch { XCTAssertEqual(error as? HostClientError, expected) }
            let sent = await transport.sent(); XCTAssertEqual(sent.count, 1)
        }
    }

    func testActualURLSessionOwnerGETAgainstRealSyntheticHostAndRedirectRefusal() async throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], node.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: node) else { throw XCTSkip("DEXTER_TEST_NODE is required for the owned synthetic HTTP fixture") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-mac-connection-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var source = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { source.deleteLastPathComponent() }
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [source.appendingPathComponent("tests/fixtures/local-mac-agent-connection-http.mjs").path, root.path]
        process.environment = [:]; process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate(); process.waitUntilExit() }
            try? FileManager.default.removeItem(at: root)
        }
        try process.run()
        func line() throws -> [String: Any] {
            var bytes = Data()
            while bytes.count <= 32768 {
                guard let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { throw HostClientError.offline }
                if byte.first == 10 { return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any]) }
                bytes.append(byte)
            }
            throw HostClientError.contractMismatch
        }
        let started = try line()
        let port = try XCTUnwrap(started["port"] as? Int), installation = try XCTUnwrap(started["installationId"] as? String)
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!)
        let value = try await client.localMacAgentConnection()
        XCTAssertEqual(value.installationID, installation)
        XCTAssertEqual(value.hostFingerprint, started["hostFingerprint"] as? String)
        XCTAssertEqual(value.hostURL, started["hostUrl"] as? String)
        try input.fileHandleForWriting.write(contentsOf: Data("redirect\n".utf8)); _ = try line()
        do { _ = try await client.localMacAgentConnection(); XCTFail("redirect followed") }
        catch { XCTAssertEqual(error as? HostClientError, .hostFailure) }
        try input.fileHandleForWriting.write(contentsOf: Data("finish\n".utf8))
        let proof = try line()
        XCTAssertEqual(proof["metadataRequests"] as? Int, 2)
        XCTAssertEqual(proof["redirectTargetRequests"] as? Int, 0)
        XCTAssertEqual(proof["offers"] as? Int, 0); XCTAssertEqual(proof["claims"] as? Int, 0)
        XCTAssertEqual(proof["devices"] as? Int, 0); XCTAssertEqual(proof["grants"] as? Int, 0)
        await client.close().value
        process.waitUntilExit(); XCTAssertEqual(process.terminationStatus, 0)
    }
}

private actor MacConnectionTransport: HTTPTransport {
    enum Step: Sendable { case success(Int, Data); case failure(URLError) }
    private var steps: [Step]
    private var requests: [URLRequest] = []
    private var protected = 0
    init(_ steps: [Step]) { self.steps = steps }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(request)
        guard !steps.isEmpty else { throw URLError(.badServerResponse) }
        switch steps.removeFirst() {
        case .success(let status, let data): return .init(statusCode: status, data: data)
        case .failure(let error): throw error
        }
    }
    func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse {
        protected += 1; return try await send(request)
    }
    func sent() -> [URLRequest] { requests }
    func protectedCount() -> Int { protected }
}
