import Foundation
import XCTest
@testable import DexterHostClient

/// Contract proof against REAL host responses: `Fixtures/connections-golden.json` is produced by the TypeScript host routes
/// (synthetic trusted service + fake Composio over loopback HTTP). Request hashes computed here must equal the host's.
final class ConnectionsHostClientTests: XCTestCase, @unchecked Sendable {
    private struct Golden: Decodable { let hostId: String; let botId: String; let calls: [String: Call] }
    private struct Call: Decodable { let method: String; let path: String; let status: Int; let request: JSONValue?; let response: JSONValue }
    private func golden() throws -> Golden {
        let url = Bundle.module.url(forResource: "connections-golden", withExtension: "json")
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/connections-golden.json")
        return try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
    }
    private func bytes(_ value: JSONValue) throws -> Data { try JSONEncoder().encode(value) }
    private func client(_ responses: [TransportResponse]) -> (HostClient, ConnectionsTransport) {
        let transport = ConnectionsTransport(responses: responses)
        return (HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, transport: transport), transport)
    }

    func testRealHostResponsesDecodeAndRequestHashesMatchTheHost() async throws {
        let g = try golden()
        let order = ["status", "catalog", "start", "callback", "authorization", "account", "access", "accounts", "accountAfterAccess", "label", "accountAfterLabel",
                     "disconnect", "receipt", "labelReceipt"]
        let (client, transport) = client(try order.map { TransportResponse(statusCode: g.calls[$0]!.status, data: try bytes(g.calls[$0]!.response)) })
        defer { client.close() }
        let status = try await client.connectionsStatus()
        XCTAssertEqual(status.platform, .available); XCTAssertEqual(status.managedProviders, ["composio"]); XCTAssertEqual(status.nativeOAuthPersistence, .unconfigured)
        let catalog = try await client.connectionsCatalog()
        XCTAssertEqual(catalog.hostId, g.hostId); XCTAssertEqual(catalog.services.first?.serviceId, "gmail")
        XCTAssertEqual(catalog.services.first?.verification, .unproven, "never presented as proven without a real authorized proof")
        let start = StartConnectionAuthorizationInput(catalog: catalog, serviceId: "gmail", clientRequestId: "golden-start-1", label: "Trabalho é 🚀")
        let authorization = try await client.startConnectionAuthorization(start)
        XCTAssertEqual(authorization.state, .awaitingUser)
        XCTAssertEqual(authorization.authorizationPage?.scheme, "https")
        XCTAssertEqual(authorization.requestHash, start.requestHash, "Swift and host canonical hashes agree")
        let returned = try await client.reportConnectionAuthorization(clientRequestID: "golden-start-1", .init(hostID: g.hostId, outcome: .returned))
        XCTAssertEqual(returned.state, .verifying); XCTAssertNil(returned.accountId)
        let connected = try await client.connectionAuthorization(clientRequestID: "golden-start-1")
        XCTAssertEqual(connected.state, .connected); XCTAssertNil(connected.authorizationPage)
        let accountID = try XCTUnwrap(connected.accountId)
        let account = try await client.connectionAccount(id: accountID)
        // Verified only through the official identity endpoint read with this account; never from the owner's label.
        XCTAssertEqual(account.identity, ConnectionAccountIdentity(confirmation: .providerVerified, value: "ana.sintetica@example.invalid", kind: .email,
                                                                   source: .identityEndpoint, issuer: nil, checkedAt: account.identity.checkedAt))
        XCTAssertNotNil(account.identity.checkedAt); XCTAssertEqual(account.label, "Trabalho é 🚀"); XCTAssertEqual(account.gatewayConnectionIds.count, 1)
        XCTAssertEqual(account.bots, [ConnectionBotAccess(botId: g.botId, access: .disabled, toolNames: nil)], "connecting grants nothing")
        let access = SetConnectionBotAccessInput(account: account, botId: g.botId, enabled: true, clientRequestId: "golden-access-1")
        let receipt = try await client.setConnectionBotAccess(accountID: accountID, access)
        XCTAssertEqual(receipt.access?.tools, 2); XCTAssertEqual(receipt.revision, account.revision + 1)
        let accounts = try await client.connectionAccounts()
        XCTAssertEqual(accounts.items.first?.bots.first?.access, .enabled)
        let after = try await client.connectionAccount(id: accountID)
        let rename = SetConnectionLabelInput(account: after, label: "Pessoal ✉️", clientRequestId: "golden-label-1")
        let renamed = try await client.setConnectionLabel(accountID: accountID, rename)
        XCTAssertEqual(renamed.kind, .label); XCTAssertEqual(renamed.label, "Pessoal ✉️"); XCTAssertEqual(renamed.revision, after.revision + 1)
        XCTAssertEqual(renamed.requestHash, rename.requestHash(accountID: accountID), "Swift and host canonical hashes agree")
        let labelled = try await client.connectionAccount(id: accountID)
        XCTAssertEqual(labelled.label, "Pessoal ✉️"); XCTAssertEqual(labelled.identity.value, "ana.sintetica@example.invalid", "a label never changes the identity")
        let disconnect = DisconnectConnectionAccountInput(account: labelled, clientRequestId: "golden-disconnect-1")
        let gone = try await client.disconnectConnectionAccount(accountID: accountID, disconnect)
        XCTAssertEqual(gone.disconnect, ConnectionUpstreamDisconnect(upstream: .deleted, revocation: .requested))
        let original = try await client.connectionReceipt(clientRequestID: "golden-access-1")
        XCTAssertEqual(original, receipt)
        let originalLabel = try await client.connectionReceipt(clientRequestID: "golden-label-1")
        XCTAssertEqual(originalLabel, renamed)
        // The exact bytes the SDK sent equal the bodies the host accepted (explicit nulls included).
        let sent = await transport.requests()
        XCTAssertEqual(sent.map { $0.httpMethod ?? "" }, order.map { g.calls[$0]!.method })
        XCTAssertEqual(sent.map { $0.url?.path }, order.map { g.calls[$0]!.path })
        for (request, name) in zip(sent, order) where g.calls[name]!.request != nil {
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody)), g.calls[name]!.request, name)
        }
    }

    func testUncertainMutationsNeverReportSuccessAndOwnerOnlyPolicy() async throws {
        let g = try golden()
        let catalogResponse = try bytes(g.calls["catalog"]!.response)
        // 503 from the host (`outcome_unknown`) and a tampered request hash are both "unknown": read, never re-send blindly.
        var tampered = g.calls["start"]!.response
        if case .object(var object) = tampered { object["requestHash"] = .string(String(repeating: "0", count: 64)); tampered = .object(object) }
        let (client, transport) = client([.init(statusCode: 200, data: catalogResponse),
                                          .init(statusCode: 503, data: Data(#"{"error":"outcome_unknown","message":"x"}"#.utf8)),
                                          .init(statusCode: 201, data: try bytes(tampered)),
                                          .init(statusCode: 404, data: Data(#"{"error":"not_found","message":"x"}"#.utf8))])
        defer { client.close() }
        let catalog = try await client.connectionsCatalog()
        let start = StartConnectionAuthorizationInput(catalog: catalog, serviceId: "gmail", clientRequestId: "golden-start-1", label: "Trabalho é 🚀")
        for _ in 0..<2 {
            do { _ = try await client.startConnectionAuthorization(start); XCTFail("must stay unknown") }
            catch let error as HostClientError { XCTAssertEqual(error, .mutationOutcomeUnknown) }
        }
        let missing = try await client.connectionReceipt(clientRequestID: "never-sent")
        XCTAssertNil(missing, "absent receipt is unconfirmed, not success")
        do { _ = try await client.startConnectionAuthorization(.init(catalog: catalog, serviceId: "Gmail!", clientRequestId: "bad")); XCTFail("refused locally") }
        catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        let account = try JSONDecoder().decode(ConnectionAccount.self, from: bytes(g.calls["account"]!.response))
        for bad in ["", String(repeating: "x", count: 81), "a\u{07}b"] {
            do { _ = try await client.setConnectionLabel(accountID: account.id, .init(account: account, label: bad, clientRequestId: "lb")); XCTFail("refused locally") }
            catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        }
        do { _ = try await client.setConnectionLabel(accountID: "mcp_notion", .init(account: account, label: "Notion", clientRequestId: "lb")); XCTFail("direct projections are read-only") }
        catch let error as HostClientError { XCTAssertEqual(error, .invalidRequest) }
        let calls = await transport.requests(); XCTAssertEqual(calls.count, 4, "invalid input never reaches the host")
        let paired = HostClient(baseURL: URL(string: "http://127.0.0.1:9991")!, accessPolicy: .unpairedHost, transport: transport)
        defer { paired.close() }
        do { _ = try await paired.connectionsCatalog(); XCTFail("owner loopback only") }
        catch let error as HostClientError { XCTAssertEqual(error, .forbidden) }
    }

    func testProjectionAndLinkInvariantsFailClosed() throws {
        let g = try golden()
        guard case .object(var authorization) = g.calls["start"]!.response else { return XCTFail("fixture") }
        authorization["authorizationURL"] = .string("dexter://steal?token=x")
        let custom = try JSONDecoder().decode(ConnectionAuthorization.self, from: bytes(.object(authorization)))
        XCTAssertNil(custom.authorizationPage, "only https official pages are opened")
        guard case .object(var account) = g.calls["account"]!.response else { return XCTFail("fixture") }
        account["nativeServerId"] = .string("forged")
        XCTAssertFalse(try JSONDecoder().decode(ConnectionAccount.self, from: bytes(.object(account))).isValid)
        account["nativeServerId"] = .null
        account["identity"] = .object(["confirmation": .string("provider_display_name"), "value": .null])
        XCTAssertFalse(try JSONDecoder().decode(ConnectionAccount.self, from: bytes(.object(account))).isValid, "a confirmation level needs a provider value")
        let unknownProvider = Data(#"{"kind":"managed","provider":"pipedream"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(ConnectionRoute.self, from: unknownProvider), "providers without a Dexter adapter are refused")
        account["identity"] = .object(["confirmation": .string("provider_verified"), "value": .string("Ana"), "kind": .string("display_name"), "source": .string("identity_endpoint"), "issuer": .null, "checkedAt": .integer(1)])
        XCTAssertFalse(try JSONDecoder().decode(ConnectionAccount.self, from: bytes(.object(account))).isValid, "a display name is never a verified identity")
        account["identity"] = .object(["confirmation": .string("unconfirmed"), "value": .null, "kind": .null, "source": .null, "issuer": .string("https://issuer.example"), "checkedAt": .null])
        XCTAssertFalse(try JSONDecoder().decode(ConnectionAccount.self, from: bytes(.object(account))).isValid, "managed accounts carry no OAuth issuer")
        let direct = Data(#"{"version":1,"hostId":"h","id":"mcp_notion","serviceId":"mcp","displayName":"Notion","route":{"kind":"direct_mcp"},"label":"Notion","identity":{"confirmation":"unconfirmed","value":null,"kind":null,"source":null,"issuer":"https://auth.notion.example","checkedAt":null},"status":"connected","statusCheckedAt":1,"persistence":"app_keychain","manage":"native_mcp","nativeServerId":"notion","revision":0,"profileId":null,"tools":[],"bots":[],"previousAccountId":null,"gatewayConnectionIds":["conn_1","conn_2"],"identityChanged":null,"disconnect":null,"createdAt":0,"updatedAt":1}"#.utf8)
        let projection = try JSONDecoder().decode(ConnectionAccount.self, from: direct)
        XCTAssertTrue(projection.isValid); XCTAssertEqual(projection.persistence, .appKeychain)
        XCTAssertEqual(projection.identity.confirmation, .unconfirmed, "direct OAuth: honest level, only the validated issuer")
        XCTAssertEqual(projection.identity.issuer, "https://auth.notion.example"); XCTAssertEqual(projection.gatewayConnectionIds, ["conn_1", "conn_2"])
        let mismatch = try JSONDecoder().decode(ConnectionAccount.self, from: bytes(g.calls["accountMismatch"]!.response))
        XCTAssertTrue(mismatch.isValid); XCTAssertEqual(mismatch.status, .identityMismatch)
        XCTAssertEqual(mismatch.identity.value, "bia.sintetica@example.invalid", "keeps the identity the owner authorized")
        XCTAssertEqual(mismatch.bots.map(\.access), [.disabled])
    }
}

private actor ConnectionsTransport: HTTPTransport {
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
