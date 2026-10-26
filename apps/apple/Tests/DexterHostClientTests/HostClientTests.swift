import Foundation
import XCTest
@testable import DexterHostClient

final class HostClientTests: XCTestCase {
    func testNodeHostFixturesDecodeContractsAndPreserveCursors() throws {
        let fixture = try loadFixtures()
        let health: HostHealth = try decode(fixture, key: "health")
        let bot: Bot = try decode(fixture, key: "bot")
        let thread: HostThread = try decode(fixture, key: "thread")
        let message: Message = try decode(fixture, key: "message")
        let turn: Turn = try decode(fixture, key: "turn")
        let action: Action = try decode(fixture, key: "action")
        let devices: ItemEnvelope<DeviceView> = try decode(fixture, key: "devices")
        let eventPage: HostEventsPage = try decode(fixture, key: "hostEvents")
        let renamedEvent: HostEvent = try decode(fixture, key: "deviceRenamedEvent")
        let turnEventPage: TurnEventsPage = try decode(fixture, key: "turnEvents")
        let ready: DoctorReadyResponse = try decode(fixture, key: "doctorReady")

        XCTAssertEqual(health.protocolVersion, 1)
        XCTAssertEqual(health.remotePairing, "not_implemented")
        XCTAssertEqual(bot.engine, .claude)
        XCTAssertEqual(thread.id, "thread_local_01")
        XCTAssertEqual(message.cursor, 7)
        XCTAssertEqual(turn.clientRequestId, "request_client_01")
        XCTAssertEqual(action.request.arguments["visible"], .bool(true))
        XCTAssertEqual(action.requestHash.count, 64)
        XCTAssertEqual(devices.items.map(\.presence), [.online, .stale, .revoked])
        XCTAssertEqual(devices.items.map(\.paired), [true, false, false])
        XCTAssertEqual(devices.items.map(\.platform), [.macos, .ios, .macos])
        XCTAssertEqual(renamedEvent.kind, .deviceRenamed)
        XCTAssertEqual(eventPage.items.first?.cursor, 41)
        XCTAssertEqual(eventPage.nextCursor, 41)
        XCTAssertEqual(turnEventPage.items.first?.cursor, 103)
        XCTAssertEqual(turnEventPage.nextCursor, 103)
        XCTAssertEqual(ready.engineInference, "not_verified")
        XCTAssertEqual(ready.remotePairing, "not_implemented")
    }

    func testCursorRequestUsesAfterAndLimitWithoutLosingHostCursor() async throws {
        let fixtures = try loadFixtures()
        let pageData = try JSONSerialization.data(withJSONObject: fixtures["hostEvents"]!)
        let transport = StubTransport(responses: [.init(statusCode: 200, data: pageData)])
        let client = makeClient(transport)

        let page = try await client.hostEvents(after: 39, limit: 2)
        let requests = await transport.capturedRequests()
        let components = URLComponents(string: try XCTUnwrap(requests.first?.url))
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })

        XCTAssertEqual(query["after"], "39")
        XCTAssertEqual(query["limit"], "2")
        XCTAssertEqual(page.items.first?.cursor, 41)
        XCTAssertEqual(page.nextCursor, 41)
    }

    func testDeviceRoutesReturnCurrentDTOAndSendOnlyMinimalRenameAndRevokeBodies() async throws {
        let fixtures = try loadFixtures()
        let devicesData = try JSONSerialization.data(withJSONObject: fixtures["devices"]!)
        let deviceRows = try XCTUnwrap((fixtures["devices"] as? [String: Any])?["items"] as? [[String: Any]])
        var renamed = try XCTUnwrap(deviceRows.first)
        renamed["name"] = "Mac de Ana"
        let revoked = try XCTUnwrap(deviceRows.last)
        let responses = [
            TransportResponse(statusCode: 200, data: devicesData),
            TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: deviceRows[0])),
            TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: renamed)),
            TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: revoked)),
        ]
        let transport = StubTransport(responses: responses)
        let client = makeClient(transport)

        let listed = try await client.listDevices()
        let current = try await client.getDevice(id: "device_mac_local_01")
        let renamedDevice = try await client.renameDevice(id: current.id, name: "  Mac de Ana  \n")
        let revokedDevice = try await client.revokeDevice(id: "device_mac_revoked_01")
        let requests = await transport.capturedRequests()
        let urls = try requests.map { try XCTUnwrap(URLComponents(string: $0.url)) }
        let renameBody = try XCTUnwrap(requests[2].body)
        let renameInput = try JSONDecoder().decode(RenameDeviceInput.self, from: renameBody)
        let revokeBody = try XCTUnwrap(requests[3].body)
        let revokeObject = try XCTUnwrap(JSONSerialization.jsonObject(with: revokeBody) as? [String: Any])

        XCTAssertEqual(listed.count, 3)
        XCTAssertEqual(current.id, "device_mac_local_01")
        XCTAssertEqual(renamedDevice.name, "Mac de Ana")
        XCTAssertEqual(renameInput.name, "Mac de Ana")
        XCTAssertEqual(revokedDevice.presence, .revoked)
        XCTAssertFalse(revokedDevice.paired)
        XCTAssertEqual(requests.map(\.method), ["GET", "GET", "PATCH", "POST"])
        XCTAssertEqual(urls.map(\.path), [
            "/v1/devices",
            "/v1/devices/device_mac_local_01",
            "/v1/devices/device_mac_local_01",
            "/v1/devices/device_mac_revoked_01/revoke",
        ])
        XCTAssertEqual(revokeObject.count, 0)
    }

    func testDeviceRenameAndRevokeFailClosedWhenResponseDoesNotMatchRequest() async throws {
        let fixtures = try loadFixtures()
        let deviceRows = try XCTUnwrap((fixtures["devices"] as? [String: Any])?["items"] as? [[String: Any]])
        let online = try JSONSerialization.data(withJSONObject: deviceRows[0])
        let badRename = try JSONSerialization.data(withJSONObject: deviceRows[1])
        var badRevokeObject = try XCTUnwrap(deviceRows[0])
        badRevokeObject["name"] = "Mac de desenvolvimento"
        let transport = StubTransport(responses: [
            .init(statusCode: 200, data: online),
            .init(statusCode: 200, data: badRename),
            .init(statusCode: 200, data: try JSONSerialization.data(withJSONObject: badRevokeObject)),
        ])
        let client = makeClient(transport)

        do {
            _ = try await client.renameDevice(id: "device_mac_local_01", name: "Renomeado")
            XCTFail("A mismatched id/name response must be rejected")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .contractMismatch)
        }

        do {
            _ = try await client.revokeDevice(id: "device_mac_local_01")
            XCTFail("A non-revoked response must not be presented as revoked")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .contractMismatch)
        }
    }

    func testGetDeviceRejectsResponseForADifferentRequestedID() async throws {
        let fixtures = try loadFixtures()
        let devices = try XCTUnwrap((fixtures["devices"] as? [String: Any])?["items"] as? [[String: Any]])
        let otherDevice = try JSONSerialization.data(withJSONObject: devices[1])
        let transport = StubTransport(responses: [.init(statusCode: 200, data: otherDevice)])
        let client = makeClient(transport)

        do {
            _ = try await client.getDevice(id: "device_mac_local_01")
            XCTFail("A device response for another ID must not be accepted")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .contractMismatch)
        }
    }

    func testRenameLimitMatchesJavaScriptUTF16LengthAtTheBoundary() async throws {
        let fixtures = try loadFixtures()
        let deviceRows = try XCTUnwrap((fixtures["devices"] as? [String: Any])?["items"] as? [[String: Any]])
        let exactLimitName = String(repeating: "😀", count: 60)
        var responseObject = try XCTUnwrap(deviceRows[0])
        responseObject["name"] = exactLimitName
        let transport = StubTransport(responses: [
            .init(statusCode: 200, data: try JSONSerialization.data(withJSONObject: responseObject)),
        ])
        let client = makeClient(transport)

        let renamed = try await client.renameDevice(id: "device_mac_local_01", name: exactLimitName)
        XCTAssertEqual(renamed.name.utf16.count, 120)

        do {
            _ = try await client.renameDevice(id: "device_mac_local_01", name: exactLimitName + "a")
            XCTFail("A 121-code-unit name must be rejected like the host's JavaScript string length check")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .invalidRequest)
        }
        let requests = await transport.capturedRequests()
        XCTAssertEqual(requests.count, 1)
    }

    func testDeviceNameNormalizerMatchesECMAScriptTrimBoundaryCharacters() {
        let whitespaceScalars: [UInt32] = [9, 10, 11, 12, 13, 32, 160, 5_760]
            + Array(8_192...8_202)
            + [8_232, 8_233, 8_239, 8_287, 12_288, 65_279]
        for value in whitespaceScalars {
            guard let scalar = Unicode.Scalar(value) else {
                XCTFail("Expected a valid Unicode scalar for U+\(String(value, radix: 16))")
                continue
            }
            let whitespace = String(scalar)
            XCTAssertEqual(
                DeviceNameNormalizer.normalize(whitespace + "Device" + whitespace),
                "Device",
                "ECMAScript String.trim removes U+\(String(value, radix: 16))"
            )
        }

        for value: UInt32 in [0x0085, 0x180E, 0x200B, 0x2060] {
            guard let scalar = Unicode.Scalar(value) else {
                XCTFail("Expected a valid Unicode scalar for U+\(String(value, radix: 16))")
                continue
            }
            let nonWhitespace = String(scalar)
            XCTAssertEqual(
                DeviceNameNormalizer.normalize(nonWhitespace + "Device" + nonWhitespace),
                nonWhitespace + "Device" + nonWhitespace,
                "ECMAScript String.trim preserves U+\(String(value, radix: 16))"
            )
        }

        XCTAssertTrue(DeviceNameNormalizer.isValid("\u{0085}"))
        XCTAssertTrue(DeviceNameNormalizer.isValid(String(repeating: "😀", count: 60)))
        XCTAssertFalse(DeviceNameNormalizer.isValid(String(repeating: "😀", count: 61)))
    }

    func testRenameRequestTrimsBOMButPreservesNELLikeTheHost() async throws {
        let fixtures = try loadFixtures()
        let rows = try XCTUnwrap((fixtures["devices"] as? [String: Any])?["items"] as? [[String: Any]])
        var response = try XCTUnwrap(rows[0])
        let expected = "\u{0085}Device name\u{0085}"
        response["name"] = expected
        let transport = StubTransport(responses: [
            .init(statusCode: 200, data: try JSONSerialization.data(withJSONObject: response)),
        ])
        let client = makeClient(transport)

        let renamed = try await client.renameDevice(
            id: "device_mac_local_01",
            name: "\u{FEFF} \u{0085}Device name\u{0085} \u{FEFF}"
        )
        let requests = await transport.capturedRequests()
        let body = try XCTUnwrap(requests.first?.body)
        let input = try JSONDecoder().decode(RenameDeviceInput.self, from: body)

        XCTAssertEqual(renamed.name, expected)
        XCTAssertEqual(input.name, expected)
        XCTAssertEqual(requests.count, 1)
    }

    func testTurnRetryReusesTheSameClientRequestIDAndBody() async throws {
        let fixtures = try loadFixtures()
        let turnData = try JSONSerialization.data(withJSONObject: fixtures["turn"]!)
        let transport = StubTransport(responses: [
            .init(statusCode: 201, data: turnData),
            .init(statusCode: 200, data: turnData),
        ])
        let client = makeClient(transport)
        let submission = TurnSubmission(content: "Summarize this", clientRequestId: "retry-stable-01")

        _ = try await client.startTurn(threadID: "thread_local_01", submission: submission)
        _ = try await client.startTurn(threadID: "thread_local_01", submission: submission)
        let requests = await transport.capturedRequests()
        let bodies = try requests.map { request -> [String: String] in
            let body = try XCTUnwrap(request.body)
            let value = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            return value
        }

        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(bodies[0], bodies[1])
        XCTAssertEqual(bodies[0]["clientRequestId"], "retry-stable-01")
        XCTAssertEqual(bodies[0]["content"], "Summarize this")
    }

    func testRemoteHostIsFailClosedWithoutSendingAnyRequest() async throws {
        let transport = StubTransport(responses: [])
        let client = HostClient(
            baseURL: URL(string: "https://dexter.example")!,
            accessPolicy: .unpairedHost,
            transport: transport
        )

        do {
            _ = try await client.health()
            XCTFail("Remote pairing must remain unavailable")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .remotePairingUnavailable)
        }
        do {
            _ = try await client.listDevices()
            XCTFail("Device administration must not open a remote host without app pairing")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .remotePairingUnavailable)
        }
        let requests = await transport.capturedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testLoopbackPolicyAlsoRejectsRemoteAddress() async throws {
        let transport = StubTransport(responses: [])
        let client = HostClient(baseURL: URL(string: "http://192.0.2.10:4317")!, transport: transport)

        do {
            _ = try await client.health()
            XCTFail("Development transport must be loopback only")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .remotePairingUnavailable)
        }
        let requests = await transport.capturedRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testIPv6LoopbackAddressIsAcceptedByDevelopmentPolicy() async throws {
        let fixtures = try loadFixtures()
        let healthData = try JSONSerialization.data(withJSONObject: fixtures["health"]!)
        let transport = StubTransport(responses: [.init(statusCode: 200, data: healthData)])
        let client = HostClient(baseURL: URL(string: "http://[::1]:4317")!, transport: transport)

        let health = try await client.health()
        let requests = await transport.capturedRequests()

        XCTAssertEqual(health.protocolVersion, 1)
        XCTAssertEqual(requests.count, 1)
        XCTAssertTrue(requests[0].url.hasPrefix("http://[::1]:4317/health"))
    }

    func testHTTPFailureBecomesSafeErrorWithoutHostMessage() async throws {
        let transport = StubTransport(responses: [
            .init(statusCode: 409, data: Data(#"{"error":"conflict","message":"secret payload from host"}"#.utf8)),
        ])
        let client = makeClient(transport)

        do {
            _ = try await client.listBots()
            XCTFail("Conflict response should fail")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .conflict)
            XCTAssertFalse(error.localizedDescription.contains("secret payload"))
        }
    }

    func testChangedApprovalArgumentsCannotBeSubmitted() async throws {
        let fixtures = try loadFixtures()
        let actionData = try JSONSerialization.data(withJSONObject: fixtures["action"]!)
        let transport = StubTransport(responses: [.init(statusCode: 200, data: actionData)])
        let client = makeClient(transport)
        let current: Action = try JSONDecoder().decode(Action.self, from: actionData)
        let changedRequest = ActionRequest(
            botId: current.request.botId,
            threadId: current.request.threadId,
            tool: current.request.tool,
            destination: current.request.destination,
            arguments: ["url": .string("https://changed.invalid"), "visible": .bool(true)],
            idempotencyKey: current.request.idempotencyKey
        )
        let changedDisplay = Action(
            id: current.id,
            request: changedRequest,
            requestHash: current.requestHash,
            grantRevision: current.grantRevision,
            state: current.state,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
            approvalExpiresAt: current.approvalExpiresAt,
            decidedBy: current.decidedBy,
            result: current.result,
            reason: current.reason
        )

        do {
            _ = try await client.decide(action: changedDisplay, decision: .allow)
            XCTFail("A changed displayed request must not be approved")
        } catch let error as HostClientError {
            XCTAssertEqual(error, .conflict)
        }
        let requests = await transport.capturedRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertTrue(requests[0].url.contains("/v1/actions/action_local_01"))
    }

    func testApprovalPostsHostIssuedHashAfterRefreshingRequest() async throws {
        let fixtures = try loadFixtures()
        let actionData = try JSONSerialization.data(withJSONObject: fixtures["action"]!)
        let transport = StubTransport(responses: [
            .init(statusCode: 200, data: actionData),
            .init(statusCode: 200, data: actionData),
        ])
        let client = makeClient(transport)
        let action: Action = try JSONDecoder().decode(Action.self, from: actionData)

        _ = try await client.decide(action: action, decision: .deny)
        let requests = await transport.capturedRequests()
        let body = try XCTUnwrap(requests.last?.body)
        let decision = try JSONDecoder().decode(ApprovalDecisionInput.self, from: body)

        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].method, "GET")
        XCTAssertEqual(requests[1].method, "POST")
        XCTAssertEqual(decision.decision, .deny)
        XCTAssertEqual(decision.requestHash, action.requestHash)
    }

    func testCancellationIsNotConvertedIntoAnOfflineError() async throws {
        let transport = StubTransport(failWithCancellation: true)
        let client = makeClient(transport)

        do {
            _ = try await client.listBots()
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            XCTAssertTrue(true)
        }
    }

    private func makeClient(_ transport: StubTransport) -> HostClient {
        HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport)
    }

    private func loadFixtures() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "node-host-responses", withExtension: "json"))
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func decode<Value: Decodable>(_ fixture: [String: Any], key: String) throws -> Value {
        let object = try XCTUnwrap(fixture[key])
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(Value.self, from: data)
    }
}

private struct CapturedRequest: Sendable {
    let url: String
    let method: String?
    let body: Data?
}

private actor StubTransport: HTTPTransport {
    private var responses: [TransportResponse]
    private var requests: [CapturedRequest] = []
    private let failWithCancellation: Bool

    init(responses: [TransportResponse] = [], failWithCancellation: Bool = false) {
        self.responses = responses
        self.failWithCancellation = failWithCancellation
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(CapturedRequest(url: request.url?.absoluteString ?? "", method: request.httpMethod, body: request.httpBody))
        if failWithCancellation { throw CancellationError() }
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }

    func capturedRequests() -> [CapturedRequest] { requests }
}
