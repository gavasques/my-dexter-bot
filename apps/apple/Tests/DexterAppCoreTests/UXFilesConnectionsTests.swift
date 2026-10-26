#if os(macOS)
import CryptoKit
import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterClientIdentity
@testable import DexterHostClient

/// Arquivos (output folders) and Conectar apps (managed connections) in the app layer (ux-main-opus55-files-connections).
/// Synthetic transports only: the connections host below answers with the REAL host responses of
/// `DexterHostClientTests/Fixtures/connections-golden.json`, re-bound to each request (ids, hashes, revisions). No process,
/// Keychain, account, provider, browser, inference, microphone, personal host or 4317/4318.
@MainActor final class UXFilesConnectionsTests: XCTestCase {

    // MARK: Arquivos

    func testOwnerBaseGetsItsOwnLoopbackSessionAndManagedEditor() async throws {
        let wire = Phase2Host()
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49941")!, transport: wire), storage: Phase2Storage())
        await model.refresh()
        XCTAssertTrue(model.isOnline)
        XCTAssertEqual(model.outputFilesBase, .thisMac)
        XCTAssertFalse(model.showsPairedBase)
        let session = try XCTUnwrap(model.makeOutputFilesSession())
        defer { session.close() }
        XCTAssertEqual(session.base, .thisMac)
        XCTAssertEqual(session.scope, model.filesScope)
        XCTAssertTrue(session.editor.clientMatchesBase); XCTAssertTrue(session.editor.canBrowse); XCTAssertTrue(session.editor.canManageDestination)
        let connections = try XCTUnwrap(model.makeManagedConnectAppsEditor())
        XCTAssertEqual(connections.scope, model.filesScope)
        connections.close()
        let early = await session.item(namespace: .bot("bot_a"), path: "a.txt", generation: nil)
        XCTAssertNil(early, "no status accepted yet: nothing is asked")
    }

    func testRemoteSessionUsesOnlyThePairedClientAndNeverClosesIt() async throws {
        let installation = "host_vps_files"
        let readOnly = try binding(installation: installation, scopes: [.chatRead, .outputsRead])
        let sender = FCPairedSender(hostID: installation, scopes: readOnly.scopes)
        let paired = HostClient(baseURL: readOnly.host.url, accessPolicy: .pairedHost(readOnly),
                                transport: PairedHTTPTransport(binding: readOnly, sender: sender))
        defer { paired.close() }
        let session = OutputFilesSession(base: .remote(hostID: installation), client: paired, ownsClient: false, scope: "window-a")
        XCTAssertTrue(session.editor.canBrowse)
        XCTAssertFalse(session.editor.canManageDestination, "outputs.read never implies outputs.manage")
        await session.editor.reload()
        XCTAssertEqual(session.editor.status?.hostId, installation)
        XCTAssertEqual(session.editor.access(location: try XCTUnwrap(session.editor.status?.current)), .downloadOnly, "a remote path never goes to Finder")
        session.close()
        // The model's paired transport survives the session (it is the conversation transport too).
        let status = try await paired.outputFilesStatus()
        XCTAssertEqual(status.hostId, installation)

        // A loopback client can never stand in for that VPS: refused before any byte is sent.
        let local = FCScriptedTransport([])
        let loopback = HostClient(baseURL: URL(string: "http://127.0.0.1:49942")!, transport: local)
        let wrong = OutputFilesSession(base: .remote(hostID: installation), client: loopback, ownsClient: true, scope: "window-a")
        XCTAssertFalse(wrong.editor.canBrowse)
        await wrong.editor.reload()
        XCTAssertEqual(wrong.editor.notice, .remoteBrowsingUnavailable)
        let sent = await local.sent()
        XCTAssertTrue(sent.isEmpty)
        wrong.close()
        do { _ = try await loopback.outputFilesStatus(); XCTFail("an owned client is closed with its session") } catch {}
    }

    func testItemsArePinnedToTheHostTheSessionAccepted() async throws {
        let hostID = "host_synthetic_outputs"
        let transport = FCScriptedTransport([.success(200, Self.outputStatus(hostID)), .success(200, Self.outputLocations(hostID)),
                                             .success(200, Self.outputNamespaces(hostID)),
                                             .success(200, Self.outputItem("host_other")), .success(200, Self.outputItem(hostID))])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49943")!, transport: transport)
        let session = OutputFilesSession(base: .thisMac, client: client, ownsClient: true, scope: "s")
        defer { session.close() }
        await session.editor.reload()
        XCTAssertEqual(session.editor.status?.hostId, hostID)
        let foreign = await session.item(namespace: .bot("bot_a"), path: "slides/a.txt", generation: nil)
        XCTAssertNil(foreign, "an item from another host is never exported")
        let own = await session.item(namespace: .bot("bot_a"), path: "slides/a.txt", generation: nil)
        XCTAssertEqual(own?.hostId, hostID)
    }

    func testSectionsShowOnlyWhatTheHostListsAndGroupsHaveNoNamespace() throws {
        let data = Data(#"{"version":1,"hostId":"h","generation":2,"truncated":false,"items":[{"ref":"bot:b2","kind":"bot","id":"b2","label":"Zeca","status":"active","exists":true,"relativePath":"bots/b2"},{"ref":"general","kind":"general","id":null,"label":null,"status":"active","exists":true,"relativePath":"general"},{"ref":"team:t1","kind":"team","id":"t1","label":"Casa","status":"active","exists":false,"relativePath":"teams/t1"},{"ref":"bot:b1","kind":"bot","id":"b1","label":"Ana","status":"orphan","exists":true,"relativePath":"bots/b1"}]}"#.utf8)
        let items = try JSONDecoder().decode(OutputNamespaces.self, from: data).items
        let sections = OutputFilesPresentation.sections(items)
        XCTAssertEqual(sections.general?.ref, .general)
        XCTAssertEqual(sections.bots.map(\.ref), [.bot("b1"), .bot("b2")])
        XCTAssertEqual(sections.teams.map(\.ref), [.team("t1")])
        XCTAssertEqual(OutputFilesPresentation.only(.bot("b2"), in: items)?.label, "Zeca")
        XCTAssertNil(OutputFilesPresentation.only(.team("t9"), in: items), "a bot or team view never falls back to another namespace")
        XCTAssertNil(OutputNamespaceRef(rawValue: "group:g1"), "private groups have no output namespace to expose")
        let grouped = Data(#"{"version":1,"hostId":"h","generation":2,"truncated":false,"items":[{"ref":"group:g1","kind":"bot","id":"g1","label":"G","status":"active","exists":true,"relativePath":"x"}]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(OutputNamespaces.self, from: grouped))
        XCTAssertTrue(OutputFilesPresentation.noticeKey(.baseOffline, base: .remote(hostID: "v")).contains("Nada é mostrado deste Mac"))
        XCTAssertTrue(OutputFilesPresentation.noticeKey(.destinationSaved, base: .thisMac).contains("nada foi movido"))
    }

    // MARK: Conectar apps

    func testUnconfiguredAndUnavailableReadStatusAndAccountsOnlyAndStartNothing() async throws {
        for platform in ["unconfigured", "unavailable"] {
            let host = try FCConnectionsHost(platform: platform)
            let editor = ManagedConnectAppsEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49944")!, transport: host), ownsClient: true, scope: "s")
            defer { editor.close() }
            await editor.reload()
            XCTAssertEqual(editor.platform?.rawValue, platform)
            XCTAssertNil(editor.catalog, "no catalog is read unless the platform is available")
            let page = await editor.startAuthorization(serviceID: "gmail")
            XCTAssertNil(page); XCTAssertNil(editor.pendingAuthorization)
            let log = await host.log()
            XCTAssertEqual(log, ["GET /v1/connections/status", "GET /v1/connections/accounts"], platform)
        }
    }

    func testAvailableLoginIsOnePostAndItsOutcomeIsOnlyRead() async throws {
        let host = try FCConnectionsHost(platform: "available")
        let editor = ManagedConnectAppsEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49945")!, transport: host), ownsClient: true, scope: "s")
        defer { editor.close() }
        await editor.reload()
        XCTAssertEqual(editor.catalog?.services.first?.serviceId, "gmail")
        XCTAssertEqual(editor.catalog?.services.first?.verification, .unproven)
        XCTAssertEqual(editor.managedAccounts.count, 1)
        let started = await editor.startAuthorization(serviceID: "gmail")
        let page = try XCTUnwrap(started)
        XCTAssertEqual(page.scheme, "https", "only the official https page is opened")
        let pending = try XCTUnwrap(editor.pendingAuthorization)
        let second = await editor.startAuthorization(serviceID: "gmail")
        XCTAssertNil(second, "one login at a time per window")
        await host.connectOnRead()
        await editor.checkAuthorization()
        XCTAssertEqual(editor.authorization?.state, .connected)
        XCTAssertNil(editor.pendingAuthorization)
        try await waitUntil { await host.count("GET /v1/connections/status") >= 2 && !editor.busy }
        XCTAssertEqual(editor.notice, .connected)
        let log = await host.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("POST") }, ["POST /v1/connections/authorizations"])
        XCTAssertTrue(log.contains("GET /v1/connections/authorizations/\(pending.clientRequestId)"), "the outcome is read by the same request id")
        XCTAssertFalse(log.contains { $0.contains("/callback") }, "the app never claims the page returned")
    }

    func testUnknownStartIsSettledOnlyByReadingTheSameRequest() async throws {
        let host = try FCConnectionsHost(platform: "available", startAnswersUnknown: true)
        let editor = ManagedConnectAppsEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49946")!, transport: host), ownsClient: true, scope: "s")
        defer { editor.close() }
        await editor.reload()
        let lost = await editor.startAuthorization(serviceID: "gmail")
        XCTAssertNil(lost)
        XCTAssertEqual(editor.notice, .authorizationUnknown)
        let pending = try XCTUnwrap(editor.pendingAuthorization)
        let again = await editor.startAuthorization(serviceID: "gmail")
        XCTAssertNil(again, "never a second POST while the first is unknown")
        let page = await editor.checkAuthorization()
        XCTAssertEqual(page?.scheme, "https", "the applied request is found by reading it; its page is offered again")
        XCTAssertEqual(editor.pendingAuthorization, pending)
        XCTAssertNil(editor.notice)
        let posts = await host.count("POST /v1/connections/authorizations")
        XCTAssertEqual(posts, 1)
    }

    func testLabelIsCASAndAnUnknownOutcomeIsSettledByItsReceipt() async throws {
        let host = try FCConnectionsHost(platform: "available", labelAnswersUnknown: true)
        let editor = ManagedConnectAppsEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49947")!, transport: host), ownsClient: true, scope: "s")
        defer { editor.close() }
        await editor.reload()
        let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.setLabel(account, to: "Casa")
        XCTAssertEqual(editor.notice, .labelUnknown)
        XCTAssertNotNil(editor.pendingLabel)
        await editor.setLabel(account, to: "Outro")
        let patches = await host.count("PATCH /v1/connections/accounts/\(account.id)/label")
        XCTAssertEqual(patches, 1, "nothing else is sent while the first outcome is unknown")
        await editor.checkLabel()
        XCTAssertNil(editor.pendingLabel)
        XCTAssertEqual(editor.notice, .labelSaved)
        XCTAssertEqual(editor.managedAccounts.first?.label, "Casa")
        XCTAssertEqual(editor.managedAccounts.first?.revision, account.revision + 1)
        // A stale revision is a conflict: re-read, never forced.
        await host.bumpRevision()
        let stale = try XCTUnwrap(editor.managedAccounts.first)
        await editor.setLabel(stale, to: "Trabalho")
        XCTAssertEqual(editor.notice, .labelConflict)
        XCTAssertNil(editor.pendingLabel)
    }

    func testAnotherHostAndPairedClientsAreRefused() async throws {
        let host = try FCConnectionsHost(platform: "available")
        let editor = ManagedConnectAppsEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49948")!, transport: host), ownsClient: true, scope: "s")
        defer { editor.close() }
        await editor.reload()
        let first = editor.status?.hostId
        await host.switchHost()
        await editor.reload()
        XCTAssertEqual(editor.notice, .hostChanged)
        XCTAssertEqual(editor.status?.hostId, first, "nothing from the other host is shown")

        // Without the owner-granted connections scopes nothing reaches the paired base (outputs alone are not enough).
        let binding = try binding(installation: "host_vps_connections", scopes: ClientScope.legacyPairing + [.outputsRead, .outputsManage])
        let sender = FCPairedSender(hostID: "host_vps_connections", scopes: binding.scopes)
        let paired = HostClient(baseURL: binding.host.url, accessPolicy: .pairedHost(binding), transport: PairedHTTPTransport(binding: binding, sender: sender))
        let remote = ManagedConnectAppsEditor(client: paired, ownsClient: false, scope: "s")
        await remote.reload()
        XCTAssertFalse(remote.canReadConnections); XCTAssertFalse(remote.canManageConnections)
        XCTAssertNil(remote.status); XCTAssertNil(remote.notice, "nothing is read, so nothing failed")
        let routed = await sender.paths()
        XCTAssertTrue(routed.isEmpty, "without connections.read nothing reaches a paired base")
        remote.close(); paired.close()
    }

    func testIdentityIsConfirmedOnlyWhenTheProviderVerifiedIt() {
        let verified = ConnectionAccountIdentity(confirmation: .providerVerified, value: "ana@example.invalid", kind: .email, source: .identityEndpoint, issuer: nil, checkedAt: 1)
        let named = ConnectionAccountIdentity(confirmation: .providerDisplayName, value: "Ana", kind: .displayName, source: .providerLabel, issuer: nil, checkedAt: 1)
        let unconfirmed = ConnectionAccountIdentity(confirmation: .unconfirmed, value: nil, kind: nil, source: nil, issuer: "https://mcp.exemplo.com", checkedAt: nil)
        XCTAssertEqual(ManagedConnectAppsPresentation.identityLine(verified, portuguese: true), "Conta confirmada pelo serviço: ana@example.invalid")
        XCTAssertFalse(ManagedConnectAppsPresentation.identityLine(named, portuguese: true).contains("confirmada pelo"))
        XCTAssertTrue(ManagedConnectAppsPresentation.identityLine(named, portuguese: true).contains("não é uma conta confirmada"))
        XCTAssertEqual(ManagedConnectAppsPresentation.identityLine(unconfirmed, portuguese: true), "Conta não confirmada · emitido por https://mcp.exemplo.com")
    }

    // MARK: Fixtures

    private func waitUntil(_ condition: @escaping @MainActor () async -> Bool) async throws {
        for _ in 0..<300 { if await condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
        XCTFail("condition not reached")
    }

    /// A real synthetic server certificate (own TLS fixture process on a random loopback port, closed at once); the
    /// paired leg itself is the scripted sender, so nothing is sent to that process.
    private func binding(installation: String, scopes: [ClientScope]) throws -> PairedHostBinding {
        let fixture = try IntegrationTLSFixture(identity: try ClientNativeIdentity.ephemeralFixture())
        let certificate = fixture.der, fingerprint = fixture.fingerprint
        fixture.close()
        let host = try PinnedClientHost(url: URL(string: "https://127.0.0.1:49949")!, certificateDER: certificate, fingerprint: fingerprint)
        let scope = try ClientIdentityScope(installationID: installation, localBindingID: String(repeating: "c", count: 32), role: .clientMac, hostFingerprint: fingerprint)
        let bundle = try ClientPairingBundle(host: host, installationID: installation, offerID: "offer", role: .clientMac, expiresAt: Date().addingTimeInterval(300), code: String(repeating: "y", count: 43))
        return try PairedHostBinding(bundle: bundle, scope: scope, identity: try ClientNativeIdentity.ephemeralFixture(), claimID: "claim",
            value: ["protocol": "dexter-app-client-v1", "status": "approved", "deviceId": "device_fixture", "installationId": installation, "ownerId": "owner_fixture",
                    "role": "client-mac", "scopes": scopes.map(\.rawValue).sorted(), "pinGeneration": 1, "bindingRevision": 1])
    }

    nonisolated static func outputStatus(_ hostID: String) -> Data {
        Data("""
        {"version":1,"hostId":"\(hostID)","revision":1,"persisted":true,"current":{"generation":1,"kind":"host_data_default","layout":"v1","path":"/synthetic/outputs","current":true,"availability":"available","namespaces":{"general":true,"bots":true,"teams":true},"createdAt":1,"retiredAt":null},"host":{"platform":"linux"},"scope":{"botFileTools":"own_bot_namespace","teamFileTools":"team_namespace_revalidated","groupTurns":"no_file_tools","terminalCwd":"output_namespace_not_os_sandbox","engineNativeWorkspace":"internal_not_outputs","contextDocuments":"separate_custody","sharing":"not_implemented","remoteBrowsing":"owner_loopback_only"},"limits":{"pageEntries":200,"scannedEntries":10000,"chunkBytes":8388608,"exportBytes":2147483648,"hashedBytes":268435456,"toolFileBytes":65536}}
        """.utf8)
    }
    nonisolated static func outputLocations(_ hostID: String) -> Data {
        Data(#"{"version":1,"hostId":"\#(hostID)","revision":1,"items":[{"generation":1,"kind":"host_data_default","layout":"v1","path":"/synthetic/outputs","current":true,"availability":"available","namespaces":{"general":true,"bots":true,"teams":true},"createdAt":1,"retiredAt":null}]}"#.utf8)
    }
    nonisolated static func outputNamespaces(_ hostID: String) -> Data {
        Data(#"{"version":1,"hostId":"\#(hostID)","generation":1,"items":[{"ref":"bot:bot_a","kind":"bot","id":"bot_a","label":"A","status":"active","exists":true,"relativePath":"bots/bot_a"}],"truncated":false}"#.utf8)
    }
    nonisolated static func outputItem(_ hostID: String) -> Data {
        Data(#"{"version":1,"hostId":"\#(hostID)","generation":1,"namespace":"bot:bot_a","path":"slides/a.txt","name":"a.txt","bytes":3,"modifiedAt":1,"mediaType":"text/plain","pin":"\#(String(repeating: "a", count: 64))","sha256":null,"exportable":true}"#.utf8)
    }
}

private actor FCScriptedTransport: HTTPTransport {
    enum Step: Sendable { case success(Int, Data) }
    private var steps: [Step]
    private var captured: [URLRequest] = []
    init(_ steps: [Step]) { self.steps = steps }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        captured.append(request)
        guard !steps.isEmpty else { throw URLError(.badServerResponse) }
        switch steps.removeFirst() { case .success(let status, let data): return TransportResponse(statusCode: status, data: data) }
    }
    func sent() -> [URLRequest] { captured }
}

/// Paired leg without TLS: mirrors the native transport's scope gate and answers the output-folder reads of one VPS.
private final class FCPairedSender: PairedNativeSending, @unchecked Sendable {
    let hostID: String
    let scopes: [ClientScope]
    private let lock = NSLock()
    private var routed: [String] = []
    init(hostID: String, scopes: [ClientScope]) { self.hostID = hostID; self.scopes = scopes }
    func paths() async -> [String] { lock.withLock { routed } }
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        lock.withLock { routed.append(request.route.path) }
        guard request.route.scope.map({ scopes.contains($0) }) ?? true else { throw ClientIdentityFailure.forbidden }
        let path = request.route.path
        let data: Data
        if path.hasPrefix("/v1/output-files/status") { data = UXFilesConnectionsTests.outputStatus(hostID) }
        else if path.hasPrefix("/v1/output-files/locations") { data = UXFilesConnectionsTests.outputLocations(hostID) }
        else if path.hasPrefix("/v1/output-files/namespaces") { data = UXFilesConnectionsTests.outputNamespaces(hostID) }
        else { return ClientTransportResponse(statusCode: 404, data: Data(#"{"error":"not_found","message":"x"}"#.utf8)) }
        return ClientTransportResponse(statusCode: 200, data: data)
    }
    func close() -> ClientTransportClose { ClientTransportClose(Task {}) }
}

/// Owner-loopback connections host built from the real host's golden responses, re-bound per request: the start answer
/// carries the request's own id and canonical hash, the label receipt the account's revision. Optional lost answers
/// (503 `outcome_unknown` after the host applied the request) prove that the app settles them by reading only.
private actor FCConnectionsHost: HTTPTransport {
    private let calls: [String: Any]
    private var hostID: String
    private let platform: String
    private let startAnswersUnknown: Bool
    private let labelAnswersUnknown: Bool
    private var connected = false
    private var label: String
    private var revision: Int
    private var authorizations: Set<String> = []
    private var receipts: [String: [String: Any]] = [:]
    private var entries: [String] = []

    init(platform: String, startAnswersUnknown: Bool = false, labelAnswersUnknown: Bool = false) throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("DexterHostClientTests/Fixtures/connections-golden.json")
        let golden = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let calls = try XCTUnwrap(golden["calls"] as? [String: Any])
        let account = try XCTUnwrap(((calls["accounts"] as? [String: Any])?["response"] as? [String: Any])?["items"] as? [[String: Any]]).first
        self.calls = calls
        hostID = try XCTUnwrap(golden["hostId"] as? String)
        self.platform = platform; self.startAnswersUnknown = startAnswersUnknown; self.labelAnswersUnknown = labelAnswersUnknown
        label = try XCTUnwrap(account?["label"] as? String); revision = try XCTUnwrap(account?["revision"] as? Int)
    }

    func log() -> [String] { entries }
    func count(_ entry: String) -> Int { entries.filter { $0 == entry }.count }
    func connectOnRead() { connected = true }
    func bumpRevision() { revision += 1 }
    func switchHost() { hostID = "host_" + UUID().uuidString.lowercased() }

    private func response(_ name: String) -> [String: Any] { ((calls[name] as? [String: Any])?["response"] as? [String: Any]) ?? [:] }
    private func rehost(_ value: Any) -> Any {
        if var object = value as? [String: Any] {
            for (key, item) in object { object[key] = key == "hostId" ? hostID : rehost(item) }
            return object
        }
        if let array = value as? [Any] { return array.map(rehost) }
        return value
    }
    private func json(_ value: Any, status: Int = 200) throws -> TransportResponse {
        TransportResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: rehost(value)))
    }
    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: rehost(value)))
    }
    private var account: [String: Any] {
        var item = ((response("accounts")["items"] as? [[String: Any]]) ?? []).first ?? [:]
        item["label"] = label; item["revision"] = revision
        return item
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let method = request.httpMethod ?? "GET", path = request.url?.path ?? ""
        entries.append("\(method) \(path)")
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let unknown = ["error": "outcome_unknown", "message": "synthetic lost answer"]
        switch (method, path) {
        case ("GET", "/v1/connections/status"):
            var status = response("status"); status["platform"] = platform
            if platform == "unconfigured" { status["managedProviders"] = [String]() }
            return try json(status)
        case ("GET", "/v1/connections/catalog"):
            return try json(response("catalog"))
        case ("GET", "/v1/connections/accounts"):
            return try json(["version": 1, "hostId": hostID, "items": platform == "unconfigured" ? [] : [account]])
        case ("POST", "/v1/connections/authorizations"):
            let catalog = try decode(ConnectionCatalog.self, response("catalog"))
            let id = try XCTUnwrap(body["clientRequestId"] as? String)
            let input = StartConnectionAuthorizationInput(catalog: catalog, serviceId: try XCTUnwrap(body["serviceId"] as? String), clientRequestId: id)
            authorizations.insert(id)
            if startAnswersUnknown { return try json(unknown, status: 503) }
            var started = response("start"); started["clientRequestId"] = id; started["requestHash"] = input.requestHash
            return try json(started, status: 201)
        default: break
        }
        if method == "GET", path.hasPrefix("/v1/connections/authorizations/") {
            let id = String(path.dropFirst("/v1/connections/authorizations/".count))
            guard authorizations.contains(id) else { return try json(["error": "not_found", "message": "x"], status: 404) }
            let catalog = try decode(ConnectionCatalog.self, response("catalog"))
            var value = response(connected ? "authorization" : "start")
            value["clientRequestId"] = id
            value["requestHash"] = StartConnectionAuthorizationInput(catalog: catalog, serviceId: "gmail", clientRequestId: id).requestHash
            return try json(value)
        }
        if method == "PATCH", path.hasSuffix("/label") {
            let current = try decode(ConnectionAccount.self, account)
            guard body["expectedRevision"] as? Int == revision else { return try json(["error": "conflict", "message": "x"], status: 409) }
            let id = try XCTUnwrap(body["clientRequestId"] as? String), newLabel = try XCTUnwrap(body["label"] as? String)
            let input = SetConnectionLabelInput(account: current, label: newLabel, clientRequestId: id)
            var receipt = response("label")
            receipt["clientRequestId"] = id; receipt["requestHash"] = input.requestHash(accountID: current.id)
            receipt["previousRevision"] = revision; receipt["revision"] = revision + 1; receipt["label"] = newLabel; receipt["accountId"] = current.id
            receipts[id] = receipt; label = newLabel; revision += 1
            if labelAnswersUnknown { return try json(unknown, status: 503) }
            return try json(receipt)
        }
        if method == "GET", path.hasPrefix("/v1/connections/receipts/") {
            let id = String(path.dropFirst("/v1/connections/receipts/".count))
            guard let receipt = receipts[id] else { return try json(["error": "not_found", "message": "x"], status: 404) }
            return try json(receipt)
        }
        return try json(["error": "not_found", "message": "x"], status: 404)
    }
}
#endif
