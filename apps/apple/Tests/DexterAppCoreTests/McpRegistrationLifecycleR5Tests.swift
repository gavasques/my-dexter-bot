#if os(macOS)
import CryptoKit
import DexterClientIdentity
import DexterHostClient
import Foundation
import Observation
import XCTest
@testable import DexterAppCore

@MainActor final class McpRegistrationLifecycleR5Tests: XCTestCase {
    private func fixture(_ wire: LifecycleR5Transport, port: Int) async throws -> (DexterAppModel, HostClient, McpRegistrationSession) {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire)
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(), identityStorage: { _ in LifecycleR5ForbiddenIdentity() })
        let model = DexterAppModel(client: client, storage: LifecycleR5Storage(), pairing: pairing)
        await model.refresh(); XCTAssertTrue(model.isOnline)
        return (model, client, try await model.makeMcpRegistrationSession(client: client))
    }
    private func draft(_ id: String, name: String = "Synthetic") throws -> McpHttpDraft {
        try McpHttpDraft(name: name, url: "https://example.test/mcp", authentication: .none, serverID: id)
    }
    private func held(_ wire: LifecycleR5Transport) async throws {
        for _ in 0..<150 { if await wire.isHeld() { return }; try await Task.sleep(for: .milliseconds(2)) }
        XCTFail("Synthetic response was not held")
    }
    func testPreparedHealthFailureCanBeDiscardedAndEditedBeforeAnyPOSTButBusyAndSentCannot() async throws {
        let wire = LifecycleR5Transport(), (model, client, session) = try await fixture(wire, port: 49921)
        try session.begin(httpDraft: draft("http-prepared")); let first = try XCTUnwrap(session.request)
        let namespace = session.namespace, scope = session.contextScope
        await wire.failNextHealth(); await session.submit()
        XCTAssertEqual(session.state, .prepared); XCTAssertFalse(session.mutationSent)
        let empty = await wire.mcpCalls(); XCTAssertEqual(empty, [])
        try session.discardPrepared(); XCTAssertNil(session.request); XCTAssertEqual(session.state, .idle)
        try session.begin(httpDraft: draft("http-prepared", name: "Edited")); let edited = try XCTUnwrap(session.request)
        XCTAssertNotEqual(edited.requestID, first.requestID); XCTAssertNotEqual(edited.definition, first.definition)
        XCTAssertEqual(session.namespace, namespace); XCTAssertEqual(session.contextScope, scope)
        await wire.holdNextHealth(); let sending = Task { await session.submit() }; try await held(wire)
        do { try session.discardPrepared(); XCTFail("In-flight operation cannot discard") }
        catch let error as McpRegistrationLifecycleError { XCTAssertEqual(error, .operationInFlight) }
        XCTAssertFalse(session.mutationSent); await wire.release(); await sending.value
        XCTAssertEqual(session.state, .registered)
        do { try session.discardPrepared(); XCTFail("A sent intention cannot be discarded") }
        catch let error as McpRegistrationLifecycleError { XCTAssertEqual(error, .mutationAlreadySent) }
        XCTAssertEqual(session.request, edited)
        let posts = await wire.posts(); XCTAssertEqual(posts.map(\.body), [edited.bodyData])
        client.close(); model.closeThreadPresentation()
    }
    func testScopeGetterIsPureDuringRenderingAndExplicitOperationLatchesInvalidation() async throws {
        let a = LifecycleR5Transport(), b = LifecycleR5Transport()
        let (modelA, clientA, session) = try await fixture(a, port: 49922)
        let (modelB, clientB, _) = try await fixture(b, port: 49923)
        XCTAssertEqual(modelA.bots, modelB.bots); XCTAssertEqual(modelA.approvalPolicyHostID, modelB.approvalPolicyHostID)
        try session.begin(httpDraft: draft("http-scope")); let original = session.request
        modelA.hostAddress = modelB.hostAddress; modelA.configureHost()
        let counter = LifecycleR5ObservationCounter()
        withObservationTracking { _ = session.invalidated; _ = session.state; _ = session.lastFailure; _ = session.request; _ = session.scopeMatches } onChange: { counter.increment() }
        for _ in 0..<50 { XCTAssertFalse(session.scopeMatches) }
        XCTAssertFalse(session.invalidated); XCTAssertEqual(counter.value, 0)
        XCTAssertEqual(session.state, .prepared); XCTAssertEqual(session.request, original); XCTAssertNil(session.lastFailure)
        await session.submit() // Explicit operation, no POST/GET; now permanently retires the old window.
        XCTAssertTrue(session.invalidated); XCTAssertEqual(counter.value, 1)
        XCTAssertTrue(session.invalidateIfScopeChanged()); XCTAssertFalse(session.scopeMatches)
        XCTAssertEqual(session.request, original); XCTAssertFalse(session.mutationSent)
        let callsA = await a.mcpCalls(), callsB = await b.mcpCalls(); XCTAssertEqual(callsA, []); XCTAssertEqual(callsB, [])
        clientA.close(); clientB.close(); modelA.closeThreadPresentation(); modelB.closeThreadPresentation()
    }
    func testExplicitDeferPermitsDifferentInstanceAndArchivedReadPreservesOriginalWithoutRepost() async throws {
        let wire = LifecycleR5Transport(), (model, client, session) = try await fixture(wire, port: 49924)
        await wire.makeNewAttemptsUncertain(); try session.begin(httpDraft: draft("http-old")); let old = try XCTUnwrap(session.request)
        await session.submit(); XCTAssertEqual(session.state, .unknown)
        let deferredID = try session.deferUncertainMonitoring(); XCTAssertEqual(deferredID, old.requestID)
        XCTAssertEqual(session.state, .idle); XCTAssertNil(session.request); XCTAssertFalse(session.mutationSent)
        XCTAssertTrue(session.hasUnresolvedDeferred(serverID: old.serverID))
        do { try session.begin(httpDraft: draft("http-old", name: "Another name")); XCTFail("Same unresolved instance must remain blocked") }
        catch let error as McpRegistrationLifecycleError { XCTAssertEqual(error, .instanceStillUncertain) }
        await wire.makeNewAttemptsCertain(); try session.begin(httpDraft: draft("http-new")); let fresh = try XCTUnwrap(session.request)
        await session.submit(); XCTAssertEqual(session.state, .registered)
        let freshReceipt = session.registration
        let reopened = try await model.makeMcpRegistrationSession(client: client); XCTAssertTrue(reopened === session)
        XCTAssertEqual(reopened.deferredRegistrations.first?.request, old)
        await wire.reveal(old.requestID); await session.reconcileDeferred(requestID: deferredID)
        XCTAssertEqual(session.deferredRegistrations.first?.state, .registered)
        XCTAssertFalse(session.hasUnresolvedDeferred(serverID: old.serverID))
        let actualReceipt = try await wire.storedReceipt(old.requestID)
        XCTAssertEqual(session.deferredRegistrations.first?.originalReceipt, actualReceipt)
        XCTAssertEqual(session.request, fresh); XCTAssertEqual(session.registration, freshReceipt); XCTAssertEqual(session.state, .registered)
        await wire.setAssociation(old.requestID, "removed"); await session.reconcileDeferred(requestID: deferredID)
        XCTAssertEqual(session.deferredRegistrations.first?.state, .removed)
        await wire.setAssociation(old.requestID, "replaced"); await session.reconcileDeferred(requestID: deferredID)
        XCTAssertEqual(session.deferredRegistrations.first?.state, .replaced)
        XCTAssertEqual(session.deferredRegistrations.first?.originalReceipt, actualReceipt)
        XCTAssertEqual(session.deferredRegistrations.first?.request.bodyData, old.bodyData)
        XCTAssertEqual(session.request, fresh); XCTAssertEqual(session.registration, freshReceipt)
        let posts = await wire.posts(); XCTAssertEqual(posts.filter { $0.id == old.requestID }.map(\.body), [old.bodyData])
        XCTAssertEqual(posts.filter { $0.id == fresh.requestID }.map(\.body), [fresh.bodyData])
        let paths = await wire.mcpCalls(); XCTAssertTrue(paths.allSatisfy { $0.contains("/v1/mcp/registrations") })
        client.close(); model.closeThreadPresentation()
    }
    func testArchiveCapAndValueCopyAtSameNamespaceKeepUncertaintyWhileOtherBaseSendsNothing() async throws {
        let a = LifecycleR5Transport(), b = LifecycleR5Transport()
        let (modelA, clientA, session) = try await fixture(a, port: 49925)
        let (modelB, clientB, other) = try await fixture(b, port: 49926)
        await a.makeNewAttemptsUncertain()
        for index in 0..<McpRegistrationSession.deferredLimit {
            try session.begin(httpDraft: draft("http-deferred-\(index)")); await session.submit(); try session.deferUncertainMonitoring()
        }
        XCTAssertEqual(session.deferredRemaining, 0)
        let preserved = session.deferredRegistrations
        try session.begin(httpDraft: draft("http-last")); await session.submit(); let active = try XCTUnwrap(session.request)
        do { try session.deferUncertainMonitoring(); XCTFail("Full list must not drop any uncertain intention") }
        catch let error as McpRegistrationLifecycleError { XCTAssertEqual(error, .historyFull) }
        XCTAssertEqual(session.deferredRegistrations, preserved); XCTAssertEqual(session.request, active); XCTAssertEqual(session.state, .unknown)
        let copy = McpRegistrationSession(namespace: session.namespace, contextScope: UUID(), client: clientA, previous: session, isCurrent: { true })
        XCTAssertEqual(copy.deferredRegistrations, preserved); XCTAssertEqual(copy.request, active); XCTAssertTrue(copy.mutationSent)
        let first = try XCTUnwrap(preserved.first)
        await a.reveal(first.id); await session.reconcileDeferred(requestID: first.id)
        XCTAssertEqual(session.deferredRegistrations.first?.state, .registered)
        XCTAssertEqual(copy.deferredRegistrations, preserved, "Old callbacks/updates cannot mutate a copied window's array")
        await copy.submit() // Only reads the original active request, never dispatches it again.
        XCTAssertEqual(copy.request, active); XCTAssertEqual(copy.state, .unknown)
        let postsA = await a.posts(); XCTAssertEqual(postsA.count, McpRegistrationSession.deferredLimit + 1)
        let foreign = McpRegistrationSession(namespace: other.namespace, contextScope: UUID(), client: clientB, previous: session, isCurrent: { true })
        XCTAssertEqual(foreign.deferredRegistrations, []); XCTAssertNil(foreign.request)
        await foreign.reconcileDeferred(requestID: first.id); await foreign.submit()
        let foreignCalls = await b.mcpCalls(); XCTAssertEqual(foreignCalls, [])
        // The empty-active case uses the same production copy path on explicit reopen/rebind.
        let withoutActive = McpRegistrationSession(namespace: session.namespace, contextScope: UUID(), client: clientA, isCurrent: { true })
        try withoutActive.begin(httpDraft: draft("http-copy-empty")); await withoutActive.submit(); try withoutActive.deferUncertainMonitoring()
        XCTAssertNil(withoutActive.request)
        let emptyCopy = McpRegistrationSession(namespace: withoutActive.namespace, contextScope: UUID(), client: clientA, previous: withoutActive, isCurrent: { true })
        XCTAssertNil(emptyCopy.request); XCTAssertEqual(emptyCopy.deferredRegistrations, withoutActive.deferredRegistrations)
        clientA.close(); clientB.close(); modelA.closeThreadPresentation(); modelB.closeThreadPresentation()
    }
}
@MainActor private final class LifecycleR5Storage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
private final class LifecycleR5ObservationCounter: @unchecked Sendable {
    private let lock = NSLock(); private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() { lock.lock(); defer { lock.unlock() }; count += 1 }
}
private actor LifecycleR5ForbiddenIdentity: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}
private actor LifecycleR5Transport: HTTPTransport {
    struct Post: Sendable { let id: String; let body: Data }
    private var calls: [String] = [], captured: [Post] = []
    private var receipts: [String: [String: Any]] = [:], originals: [String: Data] = [:], hidden: Set<String> = [], association: [String: String] = [:]
    private var uncertainNew = false, failHealth = false, holdHealth = false
    private var heldResponse: CheckedContinuation<Void, Never>?
    func posts() -> [Post] { captured }
    func mcpCalls() -> [String] { calls.filter { $0.contains("/v1/mcp/") } }
    func makeNewAttemptsUncertain() { uncertainNew = true }
    func makeNewAttemptsCertain() { uncertainNew = false }
    func reveal(_ id: String) { hidden.remove(id) }
    func setAssociation(_ id: String, _ state: String) { association[id] = state }
    func failNextHealth() { failHealth = true }
    func holdNextHealth() { holdHealth = true }
    func isHeld() -> Bool { heldResponse != nil }
    func release() { heldResponse?.resume(); heldResponse = nil }
    func storedReceipt(_ id: String) throws -> McpRegistrationReceipt { try JSONDecoder().decode(McpRegistrationReceipt.self, from: encode(receipts[id]!)) }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"; calls.append(method + " " + path)
        switch path {
        case "/health":
            if failHealth { failHealth = false; throw URLError(.networkConnectionLost) }
            let data = try encode(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "host-r5", "state": ["hostId": "host-r5", "ownerId": "owner-r5"]])
            if holdHealth { holdHealth = false; await withCheckedContinuation { heldResponse = $0 } }
            return .init(statusCode: 200, data: data)
        case "/v1/bots": return .init(statusCode: 200, data: try encode(["items": [["id": "bot-r5", "name": "Same synthetic", "profileId": "profile-r5", "ownerId": "owner-r5", "engine": "claude", "revision": 0, "createdAt": 1]]]))
        case "/v1/actions", "/v1/events", "/v1/teams", "/v1/live-voice/settings": return .init(statusCode: 200, data: try encode(["items": [], "nextCursor": 0]))
        case "/v1/mcp/registrations" where method == "POST":
            let body = try XCTUnwrap(request.httpBody), input = try JSONSerialization.jsonObject(with: body) as! [String: Any], id = input["requestId"] as! String
            captured.append(Post(id: id, body: body))
            if let previous = originals[id], previous != body { return .init(statusCode: 409, data: Data()) }
            if receipts[id] == nil { originals[id] = body; receipts[id] = try receipt(input) }
            if uncertainNew { hidden.insert(id); throw URLError(.networkConnectionLost) }
            return .init(statusCode: 201, data: try encode(["receipt": receipts[id]!]))
        default:
            guard method == "GET", path.hasPrefix("/v1/mcp/registrations/") else { throw HostClientError.notFound }
            let id = String(path.dropFirst("/v1/mcp/registrations/".count))
            if let receipt = receipts[id], !hidden.contains(id) { return .init(statusCode: 200, data: try encode(["registration": ["receipt": receipt, "instanceState": association[id] ?? "registered"]])) }
            return .init(statusCode: 200, data: try encode(["registration": NSNull()]))
        }
    }
    private func encode(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
    private func hash(_ value: [String: Any]) throws -> String { SHA256.hash(data: try encode(value)).map { String(format: "%02x", $0) }.joined() }
    private func receipt(_ input: [String: Any]) throws -> [String: Any] {
        let definition = input["definition"] as! [String: Any], instance = definition["id"] as! String
        var normalized = definition; normalized["source"] = ["format": "manual", "name": instance]
        let idHash = try hash(["requestId": input["requestId"]!]), inputHash = try hash(definition), pin = try hash(normalized)
        let origin = try hash(["version": 1, "installationId": "host-r5", "ownerId": "owner-r5", "origin": ["kind": "owner_local"]])
        let generation = UUID().uuidString.lowercased()
        let instancePin = SHA256.hash(data: Data("{\"definitionHash\":\"\(pin)\",\"generation\":\"\(generation)\"}".utf8)).map { String(format: "%02x", $0) }.joined()
        return ["version": 1, "operation": "mcp.register", "receiptId": UUID().uuidString.lowercased(), "requestIdHash": idHash,
            "requestKeyHash": try hash(["operation": "mcp.register", "originHash": origin, "requestIdHash": idHash]),
            "requestHash": try hash(["version": 1, "operation": "mcp.register", "expectedInstancePin": NSNull(), "definitionPin": pin, "inputHash": inputHash]),
            "inputHash": inputHash, "originHash": origin, "instanceId": instance, "generation": generation, "definitionPin": pin, "instancePin": instancePin, "registeredAt": 1]
    }
}
#endif
