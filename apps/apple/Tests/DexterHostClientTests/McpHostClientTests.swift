import Foundation
import XCTest
@testable import DexterHostClient

/// Optional integration against an explicitly launched, isolated local host and synthetic stdio server.
/// Normal test runs skip it; it never discovers a personal host or configuration.
final class McpHostClientTests: XCTestCase, @unchecked Sendable {
    func testHttpDraftStableNormalizationAndWebsiteNotResolved() throws {
        let first = try McpHttpDraft(name: " Example ", url: " HTTPS://EXAMPLE.TEST:443/a/../mcp ", authentication: .none, serverID: "http-fixture")
        let second = try McpHttpDraft(name: "Example", url: "https://example.test/mcp", authentication: .none, serverID: "http-fixture")
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.serverID, "http-fixture")
        let anotherInstance = try McpHttpDraft(name: "Example", url: second.url, authentication: .none, serverID: "http-other-instance")
        XCTAssertNotEqual(anotherInstance.serverID, first.serverID)
        XCTAssertEqual(anotherInstance.url, first.url)
        let website = try McpHttpDraft(name: "Website", url: "https://example.test", authentication: .none, serverID: "http-fixture")
        XCTAssertEqual(website.url, "https://example.test/")
        XCTAssertFalse(website.url.hasSuffix("/mcp"))
        let dot = try McpHttpDraft(name: "Dots", url: "https://example.test/a/%2e%2e/mcp", authentication: .none, serverID: "http-fixture")
        XCTAssertEqual(dot.url, second.url)
        let explicit = try McpHttpDraft(name: "Explicit", url: "http://[::1]:9001/mcp", authentication: .none, serverID: "example-local")
        XCTAssertEqual(explicit.serverID, "example-local")
    }

    func testHttpDraftRefusesSecretURLWithoutRepeatingInput() throws {
        let refused = ["https://user:synthetic-secret@example.test/mcp", "https://example.test/mcp?token=synthetic-secret",
                       "https://example.test/mcp#synthetic-secret", "https://example.test/mcp?", "https://example.test/mcp#",
                       "http://example.test/mcp", "https://example.test/\\mcp", "https://example.test/mcp\nnext"]
        for value in refused {
            do { _ = try McpHttpDraft(name: "Fixture", url: value, authentication: .none, serverID: "http-fixture"); XCTFail("Expected refusal") }
            catch let error as McpHttpDraftError {
                XCTAssertFalse((error.errorDescription ?? "").contains("synthetic-secret"))
                XCTAssertFalse((error.errorDescription ?? "").contains("example.test"))
            }
        }
    }

    func testHttpDraftExplicitAuthenticationWithoutPrivateValues() throws {
        let broker = try McpHttpDraft(name: "Private", url: "https://example.test/mcp", authentication: .broker, serverID: "http-fixture")
        guard case .object(let definition) = broker.definition, case .object(let transport) = definition["transport"] else { return XCTFail("Definition missing") }
        XCTAssertEqual(definition["auth"], .string("broker"))
        XCTAssertEqual(transport["headers"], .object(["authorization": .object(["kind": .string("secret"), "key": .string("token"), "prefix": .string("Bearer ")])]))
        let oauth = try McpHttpDraft(name: "OAuth", url: "https://example.test/mcp", authentication: .oauth, serverID: "http-fixture")
        guard case .object(let oauthDefinition) = oauth.definition, case .object(let oauthTransport) = oauthDefinition["transport"] else { return XCTFail("Definition missing") }
        XCTAssertEqual(oauthTransport["headers"], .object([:]))
        XCTAssertNil(oauthDefinition["clientId"])
    }

    func testReadinessNeedsAuthIsCompletedQueryWithHumanNextStep() throws {
        let server = try summary(status: "needs_auth", auth: "oauth")
        let tool = try JSONDecoder().decode(McpToolSummary.self, from: Data(#"{"id":"fixture-tool","name":"echo","description":"","effect":"read","state":"publishable"}"#.utf8))
        func step(_ status: String, _ credential: String, _ selected: Set<String>) throws -> McpSetupStep {
            let current = try summary(status: status, auth: "oauth")
            let credentials = try JSONDecoder().decode(McpCredentialStatus.self, from: Data("{\"serverId\":\"\(server.id)\",\"auth\":\"oauth\",\"slots\":[],\"state\":\"\(credential)\"}".utf8))
            return McpSetupStep.derive(server: current, credentials: credentials, tools: [tool], savedToolIDs: selected, selectedBotID: "bot-fixture")
        }
        XCTAssertEqual(try step("needs_auth", "unauthorized", [tool.id]), .authorizationRequired)
        XCTAssertEqual(try step("needs_auth", "unlocked", [tool.id]), .discoveryRequired)
        XCTAssertEqual(try step("ready", "unlocked", []), .selectionRequired)
        XCTAssertEqual(try step("ready", "unlocked", [tool.id]), .ready)
        XCTAssertEqual(try step("failed", "unlocked", [tool.id]), .discoveryFailed)
        XCTAssertEqual(McpSetupStep.derive(server: server, credentials: nil, tools: [tool], savedToolIDs: [tool.id], selectedBotID: "bot-fixture"), .checking)
    }

    func testAmbiguousHttpRegistrationReadsSameInputAndIDWithoutReplay() async throws {
        let draft = try McpHttpDraft(name: "Fixture", url: "http://127.0.0.1:9001/mcp", authentication: .none, serverID: "http-fixture")
        let transport = GuidedMcpTransport(responses: [.init(statusCode: 201, data: Data("invalid-json".utf8)),
            .init(statusCode: 200, data: Data("{\"servers\":[]} ".utf8)),
            .init(statusCode: 200, data: try serverData(draft, envelope: "servers"))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        do { _ = try await client.addHttpMcpServer(draft); XCTFail("Must retain possible effect") }
        catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        let missing = try await client.readHttpMcpRegistration(draft)
        XCTAssertNil(missing)
        let recovered = try await client.readHttpMcpRegistration(draft)
        XCTAssertEqual(recovered?.id, draft.serverID)
        let calls = await transport.requests()
        XCTAssertEqual(calls.map { $0.httpMethod }, ["POST", "GET", "GET"])
        XCTAssertEqual(calls.map { $0.url?.path }, Array(repeating: "/v1/mcp/servers", count: 3))
        let body = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(calls[0].httpBody))
        XCTAssertEqual(body, .object(["definition": draft.definition]))
    }

    func testHttpRegistrationNeverChainsAuthorizationDiscoveryOrSelection() async throws {
        let draft = try McpHttpDraft(name: "Fixture", url: "https://example.test/mcp", authentication: .oauth, serverID: "http-fixture")
        let transport = GuidedMcpTransport(responses: [.init(statusCode: 201, data: try serverData(draft, envelope: "server"))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        _ = try await client.addHttpMcpServer(draft)
        let calls = await transport.requests()
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.httpMethod, "POST")
        XCTAssertEqual(calls.first?.url?.path, "/v1/mcp/servers")
    }

    func testReconcileConflictingIDDoesNotUseAnotherServer() async throws {
        let draft = try McpHttpDraft(name: "Fixture", url: "https://example.test/mcp", authentication: .none, serverID: "http-fixture")
        let different = try McpHttpDraft(name: "Other", url: "https://other.test/mcp", authentication: .none, serverID: draft.serverID)
        let transport = GuidedMcpTransport(responses: [.init(statusCode: 200, data: try serverData(different, envelope: "servers"))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        do { _ = try await client.readHttpMcpRegistration(draft); XCTFail("Must retain the original definition") }
        catch let error as HostClientError { XCTAssertEqual(error, .conflict) }
        let calls = await transport.requests()
        XCTAssertEqual(calls.map { $0.httpMethod }, ["GET"])
    }

    func testOAuthReturnReadsStateWithoutAutomaticallyExecutingNextStep() async throws {
        let draft = try McpHttpDraft(name: "Fixture", url: "https://example.test/mcp", authentication: .oauth, serverID: "http-fixture")
        let credentials = Data(#"{"credentials":{"serverId":"http-fixture","auth":"oauth","slots":[],"state":"unlocked"}}"#.utf8)
        let transport = GuidedMcpTransport(responses: [.init(statusCode: 200, data: credentials),
            .init(statusCode: 200, data: try serverData(draft, envelope: "servers"))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        let observation = try await client.readMcpAuthorizationStep(serverID: draft.serverID)
        let server = try XCTUnwrap(observation.servers?.first)
        XCTAssertEqual(McpSetupStep.derive(server: server, credentials: observation.credentials, tools: [], savedToolIDs: [], selectedBotID: "bot-fixture"), .discoveryRequired)
        let calls = await transport.requests()
        XCTAssertEqual(calls.map { $0.httpMethod }, ["GET", "GET"])
        XCTAssertEqual(calls.map { $0.url?.path }, ["/v1/mcp/servers/http-fixture/credentials", "/v1/mcp/servers"])
    }

    func testOAuthStartUsesExactInstancePinOnlyOnPrivateOwnerRoute() async throws {
        let pin = String(repeating: "a", count: 64)
        let response = Data(#"{"authorization":{"authorizationUrl":"https://example.test/authorize?state=synthetic","issuer":"https://example.test","expiresAt":500000}}"#.utf8)
        let transport = GuidedMcpTransport(responses: [.init(statusCode: 200, data: response)])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        let result = try await client.startMcpOAuth(serverID: "http-fixture", expectedInstancePin: pin)
        XCTAssertEqual(result.authorizationUrl.host, "example.test")
        let calls = await transport.requests(), request = try XCTUnwrap(calls.first)
        XCTAssertEqual(calls.count, 1); XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/mcp/servers/http-fixture/oauth/start")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody)), .object(["expectedInstancePin": .string(pin)]))
        let foreign = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, accessPolicy: .unpairedHost, transport: transport)
        defer { foreign.close() }
        do { _ = try await foreign.startMcpOAuth(serverID: "http-fixture", expectedInstancePin: pin); XCTFail("Private route is not paired/unpaired access") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
        do { _ = try await client.startMcpOAuth(serverID: "http-fixture", expectedInstancePin: "arbitrary"); XCTFail("Pin must be a closed digest") }
        catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        let after = await transport.requests(); XCTAssertEqual(after.count, 1)
    }

    func testOAuthResponseInvalidURLsNeverReachBrowserConsumer() async throws {
        for url in ["javascript:alert(1)", "file:///tmp/fixture", "http://example.test/oauth", "https://user:secret@example.test/oauth", "https://example.test/oauth#state"] {
            let response = try JSONSerialization.data(withJSONObject: ["authorization": ["authorizationUrl": url, "issuer": "https://example.test", "expiresAt": 500000] as [String: Any]])
            let transport = GuidedMcpTransport(responses: [.init(statusCode: 200, data: response)])
            let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
            do { _ = try await client.startMcpOAuth(serverID: "http-fixture"); XCTFail("Invalid authorization URL must be rejected") }
            catch let error as HostClientError { XCTAssertEqual(error, .contractMismatch) }
            client.close()
        }
    }

    func testPrivateOAuthDiagnosticIsKnownWithoutExposingRawMessageOrDuplicateIDClaim() async throws {
        let data = Data(#"{"error":"conflict","message":"synthetic-private-value","diagnostic":{"stage":"authentication","code":"oauth_metadata_invalid","recovery":"owner_check_oauth_metadata"}}"#.utf8)
        let transport = GuidedMcpTransport(responses: [.init(statusCode: 409, data: data)])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        do { _ = try await client.startMcpOAuth(serverID: "http-fixture"); XCTFail("Expected fixed authentication diagnosis") }
        catch let error as McpAuthenticationDiagnosticError {
            XCTAssertEqual(error.code, .oauthMetadataInvalid)
            XCTAssertFalse(error.localizedDescription.contains("synthetic-private-value"))
            XCTAssertFalse(error.localizedDescription.contains("ID já existe"))
            XCTAssertFalse(error.localizedDescription.contains("serviço não forneceu"))
        }
        let calls = await transport.requests(); XCTAssertEqual(calls.count, 1)
    }

    func testUnknownPrivateErrorsAndTrueInstanceCASStayGenericWithoutRawMessagePromotion() async throws {
        let valid: [String: JSONValue] = ["stage": .string("authentication"), "code": .string("oauth_metadata_invalid"), "recovery": .string("owner_check_oauth_metadata")]
        var cases: [[String: JSONValue]] = [["error": .string("conflict"), "message": .string("synthetic-private-value")],
            ["error": .string("outcome_unknown"), "diagnostic": .object(valid)],
            ["error": .string("conflict"), "diagnostic": .object(valid), "extra": .string("synthetic-private-value")]]
        for changes in [["code": JSONValue.string("synthetic-private-value")], ["stage": .string("configuration")],
                        ["recovery": .string("synthetic-private-value")], ["extra": .string("synthetic-private-value")]] {
            var diagnostic = valid; diagnostic.merge(changes) { _, next in next }
            cases.append(["error": .string("conflict"), "message": .string("synthetic-private-value"), "diagnostic": .object(diagnostic)])
        }
        for body in cases {
            let transport = GuidedMcpTransport(responses: [.init(statusCode: 409, data: try JSONEncoder().encode(JSONValue.object(body)))])
            let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
            do { _ = try await client.startMcpOAuth(serverID: "http-fixture"); XCTFail("A generic/uncertain rejection cannot become a known OAuth error") }
            catch let error as HostClientError { XCTAssertEqual(error, .conflict); XCTAssertFalse(error.localizedDescription.contains("synthetic-private-value")) }
            client.close()
        }
    }

    func testAuthenticationDiagnosticIsLimitedToPrivateCredentialOperations() async throws {
        let data = Data(#"{"error":"conflict","diagnostic":{"stage":"authentication","code":"oauth_client_required","recovery":"owner_supply_registered_oauth_client"}}"#.utf8)
        let transport = GuidedMcpTransport(responses: [.init(statusCode: 409, data: data), .init(statusCode: 409, data: data)])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport)
        defer { client.close() }
        do { _ = try await client.unlockMcpCredentials(serverID: "http-fixture"); XCTFail("Expected private diagnosis") }
        catch let error as McpAuthenticationDiagnosticError { XCTAssertEqual(error.code, .oauthClientRequired) }
        do { _ = try await client.discoverMcpServer(id: "http-fixture"); XCTFail("Discovery must keep its existing status mapping") }
        catch let error as HostClientError { XCTAssertEqual(error, .conflict) }
        let calls = await transport.requests(); XCTAssertEqual(calls.count, 2)
    }

    func testDiagnosticDropsUnknownAndMismatchedValuesWithoutEcho() throws {
        let decoder = JSONDecoder()
        let known = try decoder.decode(McpSetupDiagnostic.self, from: Data(#"{"stage":"authentication","code":"needs_auth","recovery":"owner_authenticate_privately"}"#.utf8))
        XCTAssertEqual(known.code, "needs_auth")
        XCTAssertEqual(known.stage, .authentication)
        let invalid = [#"{"stage":"discovery","code":"synthetic-secret-upstream","recovery":"synthetic-secret-upstream"}"#,
                       #"{"stage":"synthetic-secret-upstream","code":"needs_auth","recovery":"owner_authenticate_privately"}"#,
                       #"{"stage":"authentication","code":"needs_auth","recovery":"synthetic-secret-upstream"}"#]
        for text in invalid {
            let dropped = try decoder.decode(McpSetupDiagnostic.self, from: Data(text.utf8))
            XCTAssertNil(dropped.code); XCTAssertNil(dropped.stage); XCTAssertNil(dropped.recovery)
            XCTAssertFalse(dropped.message.contains("synthetic-secret"))
        }
    }

    private func summary(status: String, auth: String) throws -> McpServerSummary {
        try JSONDecoder().decode(McpServerSummary.self, from: Data("{\"id\":\"http-fixture\",\"name\":\"Fixture\",\"transport\":\"streamable_http\",\"runsOn\":\"any\",\"auth\":\"\(auth)\",\"status\":\"\(status)\",\"destination\":\"https://example.test/mcp\"}".utf8))
    }

    private func serverData(_ draft: McpHttpDraft, envelope: String) throws -> Data {
        let row: [String: String] = ["id": draft.serverID, "name": draft.name, "transport": "streamable_http", "runsOn": "any",
                                   "auth": draft.authentication.rawValue, "status": "configured", "destination": draft.url]
        return try JSONSerialization.data(withJSONObject: envelope == "servers" ? [envelope: [row]] : [envelope: row])
    }

    func testLocalConfigurationRoundTrip() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["DEXTER_MCP_TEST_HOST"], let url = URL(string: address),
              let configPath = env["DEXTER_MCP_TEST_CONFIG"], let botID = env["DEXTER_MCP_TEST_BOT"] else {
            throw XCTSkip("Requires an explicitly prepared isolated host and synthetic MCP configuration.")
        }
        let client = HostClient(baseURL: url)
        defer { client.close() }
        let text = try String(contentsOfFile: configPath, encoding: .utf8)
        let preview = try await client.previewMcpImport(format: "claude_json", content: text)
        let imported = try XCTUnwrap(preview.servers.first)
        XCTAssertTrue(imported.credentialSlots.isEmpty)
        let server = try await client.addMcpServer(definition: XCTUnwrap(imported.draft))
        let initiallyEmpty = try await client.mcpTools(serverID: server.id)
        XCTAssertTrue(initiallyEmpty.isEmpty)
        let tools = try await client.discoverMcpServer(id: server.id)
        let echo = try XCTUnwrap(tools.first { $0.name == "echo_text" && $0.state == "publishable" })
        let saved = try await client.saveMcpSelection(serverID: server.id, botID: botID, toolIDs: [echo.id])
        XCTAssertEqual(saved.policy, "ask")
        let selection = try await client.mcpSelection(serverID: server.id, botID: botID)
        XCTAssertEqual(selection.toolIds, [echo.id])
        // This includes the JSON Content-Type required by the local DELETE guard.
        try await client.removeMcpServer(id: server.id)
        let remaining = try await client.mcpServers()
        XCTAssertFalse(remaining.contains { $0.id == server.id })
        let unpaired = HostClient(baseURL: url, accessPolicy: .unpairedHost)
        defer { unpaired.close() }
        do { _ = try await unpaired.mcpServers(); XCTFail("Remote policy must refuse owner-local MCP administration") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
    }
}

private actor GuidedMcpTransport: HTTPTransport {
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
