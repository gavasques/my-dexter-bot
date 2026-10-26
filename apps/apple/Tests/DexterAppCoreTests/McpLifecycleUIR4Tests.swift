#if os(macOS)
import CryptoKit
import DexterClientIdentity
import DexterHostClient
import Foundation
import Observation
import XCTest
@testable import DexterAppCore

/// UI R4: the order of calls Conexões MCP makes on the retained session for Editar dados, Deixar consulta para depois,
/// Conferir este pedido and the scope hook, plus the pure presentation helpers it renders. Real AppModel and session over
/// an injected in-process transport: no socket, port, process, account or credential.
@MainActor final class McpLifecycleUIR4Tests: XCTestCase {
    private func fixture(_ wire: McpUIR4Transport, port: Int) async throws -> (DexterAppModel, HostClient, McpRegistrationSession) {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire)
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in McpUIR4ForbiddenIdentity() })
        let model = DexterAppModel(client: client, storage: McpUIR4StateStorage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline)
        return (model, client, try await model.makeMcpRegistrationSession(client: client))
    }
    private func draft(_ id: String, name: String = "Synthetic") throws -> McpHttpDraft {
        try McpHttpDraft(name: name, url: "https://example.test/\(id)", authentication: .broker, serverID: id)
    }

    /// Prepared, the base check failed before sending: Editar dados refills the form from the original definition and
    /// drops only the preparation (0 requests); the reviewed edit is a new request with one POST.
    func testPreparedEditDropsOnlyThePreparationAndTheReviewedEditPostsOnce() async throws {
        let wire = McpUIR4Transport(), (model, client, session) = try await fixture(wire, port: 49921)
        try session.begin(httpDraft: draft("http-edit")); let prepared = try XCTUnwrap(session.request)
        await wire.failNextHealth(); await session.submit()
        XCTAssertEqual(session.state, .prepared); XCTAssertFalse(session.mutationSent); XCTAssertNotNil(session.lastFailure)
        let refill = try XCTUnwrap(McpRegistrationLifecyclePresentation.httpRefill(prepared))
        XCTAssertEqual(refill, .init(name: "Synthetic", url: "https://example.test/http-edit", authentication: .broker, serverID: "http-edit"))
        try session.discardPrepared() // Editar dados
        XCTAssertNil(session.request); XCTAssertFalse(session.mutationSent)
        let afterDiscard = await wire.mcpCalls(); XCTAssertEqual(afterDiscard, [])
        // The form shows the refill; the owner edits, reviews and registers: a new intention.
        let edited = try McpHttpDraft(name: refill.name + " editado", url: refill.url, authentication: refill.authentication, serverID: refill.serverID)
        try session.begin(httpDraft: edited); let revised = try XCTUnwrap(session.request)
        XCTAssertNotEqual(revised.requestID, prepared.requestID); XCTAssertNotEqual(revised.bodyData, prepared.bodyData)
        await session.submit(); XCTAssertEqual(session.state, .registered)
        let posts = await wire.postBodies(); XCTAssertEqual(posts, [revised.bodyData])
        XCTAssertThrowsError(try session.discardPrepared()) { XCTAssertEqual($0 as? McpRegistrationLifecycleError, .mutationAlreadySent) }
        XCTAssertNil(McpRegistrationLifecyclePresentation.httpRefill(try McpRegistrationRequest(definition: .object([
            "id": .string("local-a"), "name": .string("Local"), "transport": .object(["type": .string("stdio"), "command": .string("/usr/bin/true")]),
            "runsOn": .string("any"), "auth": .string("none")]))), "a local process is not refilled into the HTTP form")
        client.close(); model.closeThreadPresentation()
    }

    /// Unknown → Deixar consulta para depois → another connection ID registers with its own single POST; the same ID is
    /// refused with the plain sentence; Conferir este pedido is a read of the original request and never a POST.
    func testUncertainLeftForLaterFreesAnotherIDKeepsTheSameIDAndItsCheckNeverReposts() async throws {
        let wire = McpUIR4Transport(), (model, client, session) = try await fixture(wire, port: 49922)
        await wire.loseNextACK(); await wire.failNextRead()
        try session.begin(httpDraft: draft("http-a", name: "Primeiro")); let first = try XCTUnwrap(session.request)
        await session.submit()
        XCTAssertEqual(session.state, .unknown); XCTAssertTrue(session.requiresReconciliation)
        XCTAssertEqual(McpRegistrationLifecyclePresentation.unconfirmedServerIDs(openRequest: session.request, deferred: session.deferredRegistrations), ["http-a"])
        XCTAssertThrowsError(try session.begin(httpDraft: draft("http-b")), "an open outcome blocks a new intention until the owner decides")

        let kept = try session.deferUncertainMonitoring() // after the confirmation alert
        XCTAssertEqual(kept, first.requestID); XCTAssertNil(session.request); XCTAssertFalse(session.requiresReconciliation)
        let item = try XCTUnwrap(session.deferredRegistrations.first); XCTAssertTrue(item.isUnresolved); XCTAssertEqual(item.request, first)
        XCTAssertEqual(McpRegistrationLifecyclePresentation.deferredStatus(item), "Resultado em aberto")
        XCTAssertEqual(McpRegistrationLifecyclePresentation.unconfirmedServerIDs(openRequest: nil, deferred: session.deferredRegistrations), ["http-a"])
        XCTAssertTrue(session.hasUnresolvedDeferred(serverID: "http-a"))
        let callsAtDefer = await wire.mcpCalls(); XCTAssertEqual(callsAtDefer, ["POST /v1/mcp/registrations", "GET /v1/mcp/registrations/" + first.requestID])

        do { try session.begin(httpDraft: draft("http-a", name: "Primeiro de novo")); XCTFail("the same connection ID waits for its open request") }
        catch let error as McpRegistrationLifecycleError {
            XCTAssertEqual(error, .instanceStillUncertain)
            XCTAssertTrue(McpRegistrationLifecyclePresentation.notice(for: error).contains("Consultas guardadas"))
        }
        try session.begin(httpDraft: draft("http-b", name: "Segundo")); let second = try XCTUnwrap(session.request)
        await session.submit(); XCTAssertEqual(session.state, .registered)
        let posts = await wire.postBodies(); XCTAssertEqual(posts, [first.bodyData, second.bodyData])

        await session.reconcileDeferred(requestID: first.requestID) // Conferir este pedido
        let checked = try XCTUnwrap(session.deferredRegistrations.first)
        XCTAssertEqual(checked.state, .registered); XCTAssertFalse(checked.isUnresolved)
        XCTAssertEqual(McpRegistrationLifecyclePresentation.deferredStatus(checked), "Cadastro confirmado pela base")
        XCTAssertEqual(session.request, second, "checking a request left for later never replaces the active one")
        XCTAssertEqual(McpRegistrationLifecyclePresentation.unconfirmedServerIDs(openRequest: nil, deferred: session.deferredRegistrations), [])
        let finalPosts = await wire.postBodies(), effects = await wire.effects()
        XCTAssertEqual(finalPosts.count, 2); XCTAssertEqual(effects, 2)
        let lastCall = await wire.mcpCalls().last; XCTAssertEqual(lastCall, "GET /v1/mcp/registrations/" + first.requestID)
        client.close(); model.closeThreadPresentation()
    }

    /// The view reads `scopeMatches` while rendering: that read writes nothing observable. Only the change hook latches,
    /// and a latched window never revives when the old address comes back. No MCP request is made.
    func testReadingScopeWhileRenderingWritesNothingAndOnlyTheChangeHookLatches() async throws {
        let wire = McpUIR4Transport(), (model, client, session) = try await fixture(wire, port: 49923)
        try session.begin(httpDraft: draft("http-scope"))
        let address = model.hostAddress
        model.hostAddress = "http://127.0.0.1:49924" // another base: no client is configured and nothing is contacted
        let observedWrite = McpUIR4Flag()
        withObservationTracking {
            _ = session.scopeMatches; _ = session.invalidated; _ = session.state; _ = session.lastFailure
        } onChange: { observedWrite.set() }
        for _ in 0..<3 { XCTAssertFalse(session.scopeMatches) } // body-like reads
        XCTAssertFalse(observedWrite.value); XCTAssertFalse(session.invalidated)
        XCTAssertTrue(session.invalidateIfScopeChanged()) // .onChange hook
        XCTAssertTrue(observedWrite.value); XCTAssertTrue(session.invalidated)
        model.hostAddress = address
        XCTAssertFalse(session.scopeMatches, "a latched window never revives")
        await session.submit(); await session.reconcile()
        let calls = await wire.mcpCalls(); XCTAssertEqual(calls, [])
        XCTAssertEqual(McpRegistrationLifecyclePresentation.notice(for: HostClientError.forbidden),
                       "A base ou o contexto do bot mudou. Feche e reabra as conexões para usar o novo contexto. Um cadastro não confirmado continua guardado enquanto o app estiver aberto.")
        client.close(); model.closeThreadPresentation()
    }

    /// Every key the pure helper returns exists in the catalog with both languages (no ID or raw value in the sentence).
    func testLifecycleSentencesAreCatalogKeys() throws {
        let catalogURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("SharedApp/Resources/Localizable.xcstrings")
        let catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: catalogURL)) as? [String: Any]
        let strings = try XCTUnwrap(catalog?["strings"] as? [String: Any])
        let errors: [any Error] = [McpRegistrationLifecycleError.historyFull, McpRegistrationLifecycleError.operationInFlight,
            McpRegistrationLifecycleError.instanceStillUncertain, McpRegistrationLifecycleError.mutationAlreadySent,
            McpRegistrationLifecycleError.notPrepared, McpRegistrationLifecycleError.noUncertainAttempt, HostClientError.forbidden, HostClientError.notReady]
        let keys = errors.map(McpRegistrationLifecyclePresentation.notice(for:)) + ["Resultado em aberto", "Esta base não confirma cadastros",
            "Cadastro confirmado pela base", "Feito; a conexão foi removida depois", "Feito; a conexão foi substituída depois", "A base recusou o cadastro"]
        for key in keys {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            XCTAssertNotNil(localizations["en"], key); XCTAssertNotNil(localizations["pt-BR"], key)
            XCTAssertNil(key.range(of: "mac:|http-", options: .regularExpression), key)
        }
    }
}

/// Observation onChange runs as a Sendable closure: a locked flag records that it fired.
private final class McpUIR4Flag: @unchecked Sendable {
    private let lock = NSLock(); private var fired = false
    func set() { lock.lock(); fired = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return fired }
}
@MainActor private final class McpUIR4StateStorage: DexterAppStateStorage {
    var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
private actor McpUIR4ForbiddenIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}
/// Stateful in-process peer (same receipt shape and hash domains as the R4 fixture). Records every call; no sockets.
private actor McpUIR4Transport: HTTPTransport {
    private var calls: [String] = [], bodies: [Data] = [], receipts: [String: [String: Any]] = [:], originals: [String: Data] = [:]
    private var effectCount = 0, loseACK = false, readFailure = false, healthFailure = false
    func mcpCalls() -> [String] { calls.filter { $0.contains("/v1/mcp/") } }
    func postBodies() -> [Data] { bodies }
    func effects() -> Int { effectCount }
    func loseNextACK() { loseACK = true }
    func failNextRead() { readFailure = true }
    func failNextHealth() { healthFailure = true }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        calls.append(method + " " + path)
        switch path {
        case "/health":
            if healthFailure { healthFailure = false; throw URLError(.networkConnectionLost) }
            return .init(statusCode: 200, data: try encode(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "host-ui-r4", "state": ["hostId": "host-ui-r4", "ownerId": "owner-ui-r4"]]))
        case "/v1/bots":
            return .init(statusCode: 200, data: try encode(["items": [["id": "bot-ui-r4", "name": "Synthetic bot", "profileId": "profile-ui-r4", "ownerId": "owner-ui-r4", "engine": "claude", "revision": 0, "createdAt": 1]]]))
        case "/v1/actions", "/v1/events", "/v1/teams", "/v1/live-voice/settings":
            return .init(statusCode: 200, data: try encode(["items": [], "nextCursor": 0]))
        case "/v1/mcp/registrations" where method == "POST":
            let body = try XCTUnwrap(request.httpBody); bodies.append(body)
            let input = try JSONSerialization.jsonObject(with: body) as! [String: Any], id = input["requestId"] as! String
            if let previous = originals[id], previous != body { return .init(statusCode: 409, data: Data()) }
            if receipts[id] == nil { receipts[id] = try receipt(input); originals[id] = body; effectCount += 1 }
            if loseACK { loseACK = false; throw URLError(.networkConnectionLost) }
            return .init(statusCode: 201, data: try encode(["receipt": receipts[id]!]))
        default:
            guard method == "GET", path.hasPrefix("/v1/mcp/registrations/") else { throw HostClientError.notFound }
            if readFailure { readFailure = false; throw URLError(.networkConnectionLost) }
            let id = String(path.dropFirst("/v1/mcp/registrations/".count))
            if let receipt = receipts[id] { return .init(statusCode: 200, data: try encode(["registration": ["receipt": receipt, "instanceState": "registered"]])) }
            return .init(statusCode: 200, data: try encode(["registration": NSNull()]))
        }
    }
    private func encode(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
    private func hash(_ value: [String: Any]) throws -> String { SHA256.hash(data: try encode(value)).map { String(format: "%02x", $0) }.joined() }
    private func receipt(_ input: [String: Any]) throws -> [String: Any] {
        let definition = input["definition"] as! [String: Any], instance = definition["id"] as! String
        var normalized = definition; normalized["source"] = ["format": "manual", "name": instance]
        let idHash = try hash(["requestId": input["requestId"]!]), inputHash = try hash(definition), pin = try hash(normalized)
        let origin = try hash(["version": 1, "installationId": "host-ui-r4", "ownerId": "owner-ui-r4", "origin": ["kind": "owner_local"]])
        let generation = "12345678-1234-1234-1234-123456789abc"
        let instancePin = SHA256.hash(data: Data("{\"definitionHash\":\"\(pin)\",\"generation\":\"\(generation)\"}".utf8)).map { String(format: "%02x", $0) }.joined()
        return ["version": 1, "operation": "mcp.register", "receiptId": "abcdef12-1234-1234-1234-123456789abc", "requestIdHash": idHash,
            "requestKeyHash": try hash(["operation": "mcp.register", "originHash": origin, "requestIdHash": idHash]),
            "requestHash": try hash(["version": 1, "operation": "mcp.register", "expectedInstancePin": NSNull(), "definitionPin": pin, "inputHash": inputHash]),
            "inputHash": inputHash, "originHash": origin, "instanceId": instance, "generation": generation, "definitionPin": pin, "instancePin": instancePin, "registeredAt": 1]
    }
}
#endif
